import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  try {
    const [leadsRes, sessionsRes, messagesRes] = await Promise.all([
      supabase.from('leads').select('urgency_score, category'),
      supabase.from('sessions').select('id, prospect_name, prospect_email, created_at, summary').order('created_at', { ascending: false }).limit(10),
      supabase.from('session_messages').select('id', { count: 'exact', head: true })
    ]);

    const leads = leadsRes.data || [];
    const totalLeads = leads.length;
    const avgUrgency = totalLeads > 0 
      ? (leads.reduce((acc, l) => acc + (l.urgency_score || 0), 0) / totalLeads).toFixed(1)
      : 0;

    const criticalLeads = leads.filter(l => l.urgency_score >= 8).length;

    return res.status(200).json({
      success: true,
      stats: {
        totalLeads,
        criticalLeads,
        avgUrgency,
        totalMessages: messagesRes.count || 0,
        recentSessions: sessionsRes.data || []
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
