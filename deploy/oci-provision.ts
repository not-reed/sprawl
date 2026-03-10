#!/usr/bin/env bun
/**
 * Oracle Cloud Free Tier ARM instance provisioner.
 * Retries LaunchInstance every 60s until capacity opens up.
 *
 * Usage:
 *   cp deploy/.env.oci.example deploy/.env.oci
 *   # fill in your OCI credentials
 *   bun deploy/oci-provision.ts
 *
 * Requires: Bun (uses node:crypto, node:fs — no external deps)
 */

import { createSign, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// --- Config ---

const config = {
  user: env("OCI_USER"),
  tenancy: env("OCI_TENANCY"),
  fingerprint: env("OCI_FINGERPRINT"),
  region: env("OCI_REGION"),
  keyFile: env("OCI_KEY_FILE"),

  // Instance config (sensible free-tier defaults)
  displayName: env("OCI_INSTANCE_NAME", "construct"),
  ocpus: Number(env("OCI_OCPUS", "1")),
  memoryGb: Number(env("OCI_MEMORY_GB", "6")),
  bootVolumeGb: Number(env("OCI_BOOT_VOLUME_GB", "50")),
  os: env("OCI_OS", "Canonical Ubuntu"),
  osVersion: env("OCI_OS_VERSION", "24.04"),
  sshPublicKey: env("OCI_SSH_PUBLIC_KEY", ""),
  sshPublicKeyFile: env("OCI_SSH_PUBLIC_KEY_FILE", ""),

  // Optional overrides (auto-discovered if empty)
  availabilityDomain: env("OCI_AVAILABILITY_DOMAIN", ""),
  subnetId: env("OCI_SUBNET_ID", ""),
  imageId: env("OCI_IMAGE_ID", ""),

  // Retry config
  retryIntervalSecs: Number(env("OCI_RETRY_INTERVAL_SECS", "60")),

  // Telegram notification (optional)
  telegramBotToken: env("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: env("TELEGRAM_CHAT_ID", ""),
};

const privateKey = readFileSync(config.keyFile, "utf-8");

const COMPUTE_BASE = `https://iaas.${config.region}.oci.oraclecloud.com`;
const IDENTITY_BASE = `https://identity.${config.region}.oci.oraclecloud.com`;

const RETRYABLE_ERRORS = new Set(["Out of host capacity.", "TooManyRequests", "InternalError"]);

// --- OCI HTTP Signature Auth ---

function sign(method: string, url: URL, body?: string): Record<string, string> {
  const date = new Date().toUTCString();
  const host = url.host;
  const target = `${method.toLowerCase()} ${url.pathname}${url.search}`;

  const headers: Record<string, string> = {
    date,
    host,
    "content-type": "application/json",
  };

  let headersToSign = ["(request-target)", "date", "host"];

  if (body) {
    const bodyHash = createHash("sha256").update(body).digest("base64");
    headers["x-content-sha256"] = bodyHash;
    headers["content-length"] = Buffer.byteLength(body).toString();
    headersToSign = [
      "(request-target)",
      "date",
      "host",
      "content-length",
      "content-type",
      "x-content-sha256",
    ];
  }

  const signingString = headersToSign
    .map((h) => {
      if (h === "(request-target)") return `(request-target): ${target}`;
      return `${h}: ${headers[h]}`;
    })
    .join("\n");

  const signer = createSign("RSA-SHA256");
  signer.update(signingString);
  const signature = signer.sign(privateKey, "base64");

  const keyId = `${config.tenancy}/${config.user}/${config.fingerprint}`;

  headers["authorization"] =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headersToSign.join(" ")}",signature="${signature}"`;

  return headers;
}

async function ociGet<T = any>(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(path, baseUrl);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));

  const headers = sign("GET", url);
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new OciError(res.status, err.code, err.message);
  }
  return res.json();
}

async function ociPost<T = any>(
  baseUrl: string,
  path: string,
  body: Record<string, any>,
): Promise<T> {
  const url = new URL(path, baseUrl);
  const bodyStr = JSON.stringify(body);
  const headers = sign("POST", url, bodyStr);

  const res = await fetch(url, { method: "POST", headers, body: bodyStr });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new OciError(res.status, err.code, err.message);
  }
  return res.json();
}

class OciError extends Error {
  constructor(
    public status: number,
    public code: string,
    public override message: string,
  ) {
    super(`OCI ${status} ${code}: ${message}`);
  }
}

// --- Discovery ---

async function listAvailabilityDomains(): Promise<string[]> {
  const ads = await ociGet<{ name: string }[]>(IDENTITY_BASE, "/20160918/availabilityDomains", {
    compartmentId: config.tenancy,
  });
  return ads.map((ad) => ad.name);
}

async function listSubnets(): Promise<{ id: string; displayName: string }[]> {
  return ociGet(COMPUTE_BASE, "/20160918/subnets", {
    compartmentId: config.tenancy,
  });
}

async function listImages(): Promise<
  { id: string; displayName: string; operatingSystem: string; operatingSystemVersion: string }[]
> {
  return ociGet(COMPUTE_BASE, "/20160918/images", {
    compartmentId: config.tenancy,
    shape: "VM.Standard.A1.Flex",
  });
}

async function listInstances(): Promise<
  { id: string; displayName: string; lifecycleState: string; shape: string }[]
> {
  return ociGet(COMPUTE_BASE, "/20160918/instances", {
    compartmentId: config.tenancy,
    lifecycleState: "RUNNING",
  });
}

// --- Instance creation ---

async function launchInstance(ad: string, subnetId: string, imageId: string) {
  const sshKey =
    config.sshPublicKey ||
    (config.sshPublicKeyFile ? readFileSync(config.sshPublicKeyFile, "utf-8").trim() : "");

  if (!sshKey)
    throw new Error("No SSH public key provided (OCI_SSH_PUBLIC_KEY or OCI_SSH_PUBLIC_KEY_FILE)");

  return ociPost(COMPUTE_BASE, "/20160918/instances", {
    compartmentId: config.tenancy,
    availabilityDomain: ad,
    displayName: config.displayName,
    shape: "VM.Standard.A1.Flex",
    shapeConfig: {
      ocpus: config.ocpus,
      memoryInGbs: config.memoryGb,
    },
    sourceDetails: {
      sourceType: "image",
      imageId,
      bootVolumeSizeInGBs: config.bootVolumeGb,
    },
    createVnicDetails: {
      subnetId,
      assignPublicIp: true,
      displayName: config.displayName,
    },
    metadata: {
      ssh_authorized_keys: sshKey,
    },
    availabilityConfig: {
      recoveryAction: "RESTORE_INSTANCE",
    },
  });
}

// --- Notifications ---

async function notifyTelegram(message: string) {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (e) {
    log(`Telegram notification failed: ${e}`);
  }
}

// --- Main ---

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function env(key: string, fallback?: string): string {
  const val = process.env[key];
  if (val !== undefined) return val;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  log("Oracle Cloud ARM instance provisioner starting");
  log(
    `Region: ${config.region}, Shape: VM.Standard.A1.Flex (${config.ocpus} OCPU / ${config.memoryGb} GB)`,
  );

  // Check for existing ARM instances
  log("Checking for existing ARM instances...");
  const existing = await listInstances();
  const armInstances = existing.filter((i) => i.shape === "VM.Standard.A1.Flex");
  if (armInstances.length > 0) {
    log(
      `Found existing ARM instance(s): ${armInstances.map((i) => `${i.displayName} (${i.lifecycleState})`).join(", ")}`,
    );
    log("Delete existing instances first if you want to create a new one.");
    process.exit(1);
  }

  // Discover resources
  log("Discovering availability domains...");
  const allAds = await listAvailabilityDomains();
  const ads = config.availabilityDomain ? [config.availabilityDomain] : allAds;
  log(`Availability domains: ${ads.join(", ")}`);

  let subnetId = config.subnetId;
  if (!subnetId) {
    log("Discovering subnets...");
    const subnets = await listSubnets();
    if (subnets.length === 0)
      throw new Error("No subnets found. Create a VCN + subnet in OCI console first.");
    subnetId = subnets[0].id;
    log(`Using subnet: ${subnets[0].displayName} (${subnetId})`);
  }

  let imageId = config.imageId;
  if (!imageId) {
    log("Discovering images...");
    const images = await listImages();
    const match = images.find(
      (i) => i.operatingSystem === config.os && i.operatingSystemVersion === config.osVersion,
    );
    if (!match) {
      log(`Available images:`);
      images
        .slice(0, 10)
        .forEach((i) => log(`  ${i.operatingSystem} ${i.operatingSystemVersion} (${i.id})`));
      throw new Error(`No image found for ${config.os} ${config.osVersion}`);
    }
    imageId = match.id;
    log(`Using image: ${match.displayName} (${imageId})`);
  }

  // Retry loop
  let attempt = 0;
  let adIndex = 0;

  while (true) {
    attempt++;
    const ad = ads[adIndex % ads.length];
    adIndex++;

    log(`Attempt ${attempt} — AD: ${ad}`);

    try {
      const instance = await launchInstance(ad, subnetId, imageId);
      log(`Instance created! ID: ${instance.id}, state: ${instance.lifecycleState}`);

      const msg = [
        `<b>OCI instance created</b>`,
        `Name: ${config.displayName}`,
        `Region: ${config.region}`,
        `AD: ${ad}`,
        `Shape: VM.Standard.A1.Flex (${config.ocpus} OCPU / ${config.memoryGb} GB)`,
        `ID: <code>${instance.id}</code>`,
      ].join("\n");

      await notifyTelegram(msg);
      log("Done!");
      process.exit(0);
    } catch (e) {
      if (e instanceof OciError) {
        if (RETRYABLE_ERRORS.has(e.code) || RETRYABLE_ERRORS.has(e.message) || e.status === 502) {
          log(`Retryable error: ${e.message}`);
          log(`Retrying in ${config.retryIntervalSecs}s...`);
          await sleep(config.retryIntervalSecs * 1000);
          continue;
        }

        // LimitExceeded might mean instance was actually created
        if (e.code === "LimitExceeded") {
          log(`Limit exceeded — checking if instance was created...`);
          const instances = await listInstances();
          const created = instances.find((i) => i.displayName === config.displayName);
          if (created) {
            log(`Instance already exists: ${created.id} (${created.lifecycleState})`);
            await notifyTelegram(
              `<b>OCI instance already exists</b>\nID: <code>${created.id}</code>`,
            );
            process.exit(0);
          }
        }

        log(`Fatal OCI error: ${e.message}`);
        await notifyTelegram(`<b>OCI provisioner failed</b>\n<code>${e.message}</code>`);
        process.exit(1);
      }
      throw e;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
