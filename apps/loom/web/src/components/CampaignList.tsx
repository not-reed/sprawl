import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { api } from '../lib/api'

export function CampaignList() {
  const { data, loading } = useApi(() => api.listCampaigns(), [])
  const [name, setName] = useState('')
  const [system, setSystem] = useState('')
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const campaign = await api.createCampaign({
        name: name.trim(),
        system: system.trim() || undefined,
      })
      setName('')
      setSystem('')
      navigate(`/campaign/${campaign.id}`)
    } catch (err) {
      console.error('Failed to create campaign:', err)
    } finally {
      setCreating(false)
    }
  }

  if (loading) return <div className="page"><div className="loading">Loading...</div></div>

  const campaigns = data?.campaigns ?? []

  return (
    <div className="page">
      <div className="create-form">
        <h2>New Campaign</h2>
        <input
          className="input"
          type="text"
          placeholder="Campaign name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
        <input
          className="input"
          type="text"
          placeholder="Game system (e.g. Magical Kitties Save The Day)"
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
        />
        <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !name.trim()}>
          {creating ? 'Creating...' : 'Create Campaign'}
        </button>
      </div>

      {campaigns.length > 0 && (
        <div className="campaign-list">
          <h2>Campaigns</h2>
          {campaigns.map((c) => (
            <div key={c.id} className="campaign-card" onClick={() => navigate(`/campaign/${c.id}`)}>
              <div className="campaign-name">{c.name}</div>
              {c.system && <div className="campaign-system">{c.system}</div>}
              <div className="campaign-meta">
                {new Date(c.updated_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {campaigns.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No campaigns yet</div>
          <div>Create your first campaign above</div>
        </div>
      )}
    </div>
  )
}
