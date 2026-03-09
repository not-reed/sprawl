import type { Generated, Insertable, Selectable, Updateable } from 'kysely'
import type { CairnDatabase } from '@repo/cairn'

export interface Database extends CairnDatabase {
  campaigns: CampaignTable
  sessions: SessionTable
  settings: SettingTable
  [key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface CampaignTable {
  id: string
  name: string
  system: string | null
  description: string | null
  created_at: Generated<string>
  updated_at: Generated<string>
}

export type Campaign = Selectable<CampaignTable>
export type NewCampaign = Insertable<CampaignTable>
export type CampaignUpdate = Updateable<CampaignTable>

export interface SessionTable {
  id: string
  campaign_id: string
  conversation_id: string
  name: string | null
  mode: Generated<string>
  status: Generated<string>
  created_at: Generated<string>
  updated_at: Generated<string>
}

export type Session = Selectable<SessionTable>
export type NewSession = Insertable<SessionTable>
export type SessionUpdate = Updateable<SessionTable>

export interface SettingTable {
  key: string
  value: string
  updated_at: Generated<string>
}
