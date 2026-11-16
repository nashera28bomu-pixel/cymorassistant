import { useState } from 'react';
import { api } from '../services/api.js';
import { usePolling } from '../hooks/usePolling.js';
import { Pill, Stat, Switch, Loading, ErrorNote, stateTone, fmtDate, Toast } from '../components/ui.jsx';

export default function Overview() {
  const { data, error, loading, reload } = usePolling(() => api.get('/overview'), 8000);
  const [toast, setToast] = useState('');

  async function toggle(enabled) {
    try {
      await api.put('/settings', { assistantEnabled: enabled });
      setToast(enabled ? 'CYMOR ASSISTANT is ON' : 'CYMOR ASSISTANT is OFF');
      reload();
    } catch (e) {
      setToast(e.message);
    }
  }

  if (loading && !data) return <Loading />;
  const d = data;
  return (
    <>
      <div className="page-head">
        <div><h1>Overview</h1><p>Live status of your digital representative.</p></div>
        {d && (
          <div className="card row" style={{ padding: '12px 18px' }}>
            <div><div className="small muted">Assistant</div><b>{d.assistant.active ? 'ON — replying' : d.assistant.enabled ? 'ON — paused' : 'OFF'}</b></div>
            <Switch checked={d.assistant.enabled} onChange={toggle} label="Assistant on or off" />
          </div>
        )}
      </div>
      <ErrorNote error={error} />
      {d && (
        <>
          <div className="grid cols-4">
            <div className="card"><div className="small muted">WhatsApp</div><div style={{ margin: '10px 0' }}><Pill tone={stateTone(d.whatsapp.state)}>{d.whatsapp.state.replace('_', ' ')}</Pill></div><div className="small muted">{d.whatsapp.me ? `+${String(d.whatsapp.me.id).split(':')[0].split('@')[0]}` : 'Not linked'}</div></div>
            <div className="card"><div className="small muted">Gemini AI</div><div style={{ margin: '10px 0' }}><Pill tone={d.gemini.configured ? (d.gemini.failuresToday > d.gemini.requestsToday / 2 && d.gemini.failuresToday > 2 ? 'warn' : 'ok') : 'bad'}>{d.gemini.configured ? 'configured' : 'no API key'}</Pill></div><div className="small muted">{d.gemini.model} · {d.gemini.requestsToday} calls today{d.gemini.failuresToday ? `, ${d.gemini.failuresToday} failed` : ''}</div>{d.gemini.lastError && <div className="small" style={{ color: 'var(--amber)', marginTop: 6, wordBreak: 'break-word' }}>Last error: {d.gemini.lastError.message}</div>}</div>
            <div className="card"><div className="small muted">MongoDB</div><div style={{ margin: '10px 0' }}><Pill tone={d.mongodb.status === 'connected' ? 'ok' : 'bad'}>{d.mongodb.status}</Pill></div></div>
            <div className="card"><div className="small muted">Heroku</div><div style={{ margin: '10px 0' }} className="row"><Pill tone="ok">web {d.heroku.web}</Pill><Pill tone={d.heroku.worker === 'running' ? 'ok' : d.heroku.worker === 'unknown' ? 'warn' : 'bad'}>worker {d.heroku.worker}</Pill></div><div className="small muted">dyno: {d.heroku.dyno}</div></div>
          </div>
          {d.assistant.pausedUntil && new Date(d.assistant.pausedUntil) > new Date() && <p className="small" style={{ color: 'var(--amber)' }}>⏸ Paused until {fmtDate(d.assistant.pausedUntil)}</p>}
          <div className="section-title"><h2>Activity</h2></div>
          <div className="grid cols-4">
            <Stat label="Total contacts" value={d.counts.contacts} />
            <Stat label="Active conversations" value={d.counts.activeConversations} hint="last 24 hours" />
            <Stat label="Pending requests" value={d.counts.pendingRequests} tone={d.counts.pendingRequests ? 'amber' : undefined} />
            <Stat label="Messages today" value={d.counts.messagesToday} />
            <Stat label="KUCCPS inquiries" value={d.counts.kuccpsInquiries} />
            <Stat label="Website inquiries" value={d.counts.webInquiries} />
            <Stat label="Software inquiries" value={d.counts.softwareInquiries} />
          </div>
        </>
      )}
      <Toast message={toast} onDone={() => setToast('')} />
    </>
  );
}
