import type { Voice, VoiceConfig } from "../lib/types";

export function buildBlendExpression(voices: Array<{ id: string; weight: number }>): string {
  return voices.map((v) => `${v.id}(${v.weight})`).join("+");
}

const gradeOrder = ["A", "A-", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+", "-"];

export function sortVoices(voices: Voice[]): Voice[] {
  return [...voices].toSorted((a, b) => {
    const ai = gradeOrder.indexOf(a.grade);
    const bi = gradeOrder.indexOf(b.grade);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

export interface VoiceOption {
  id: string;
  label: string;
}

export function buildVoiceOptions(
  voices: Voice[],
  savedBlends: VoiceConfig["savedBlends"],
): VoiceOption[] {
  const sorted = sortVoices(voices);
  const opts: VoiceOption[] = sorted.map((v) => ({
    id: v.id,
    label: `${v.name} (${v.gender === "female" ? "\u2640" : "\u2642"} ${v.accent}${v.grade !== "-" ? `, ${v.grade}` : ""})`,
  }));
  for (const b of savedBlends || []) {
    opts.push({ id: b.expression, label: `${b.name} (Blend)` });
  }
  return opts;
}
