'use client'
import { useEffect, useState } from 'react'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''
const ratings = ['家元らしい','少し違う','全然違う','長すぎる','短すぎる','説教臭い','AIっぽい','毒が足りない','優しさが足りない','商売感覚が違う']
type Conversation = { id:string; title:string; category:string; pii_masked:number; enabled:number; review_status:string; message_count:number }
type Message = { id:string; role:string; content:string; classification:string; pii_masked:number; use_for_style:number }

async function request(path:string, init?:RequestInit) {
  const response = await fetch(`${apiBase}${path}`, { credentials:'include', headers:{ 'content-type':'application/json', ...(init?.headers || {}) }, ...init })
  if (!response.ok) throw new Error('request failed')
  return response.json()
}

export default function IemotoVoicePage() {
  const [rows,setRows] = useState<Conversation[]>([])
  const [selected,setSelected] = useState<{conversation:Conversation;messages:Message[]}|null>(null)
  const [filter,setFilter] = useState('')
  const [notice,setNotice] = useState('')
  const load = async () => setRows((await request(`/api/iemoto-voice/conversations${filter ? `?classification=${filter}` : ''}`)).data)
  useEffect(() => { load().catch(() => setNotice('会話を読み込めませんでした')) }, [filter])
  const open = async (id:string) => setSelected((await request(`/api/iemoto-voice/conversations/${id}`)).data)
  const update = async (message:Message, body:Record<string,unknown>) => { await request(`/api/iemoto-voice/messages/${message.id}`, { method:'PATCH', body:JSON.stringify(body) }); if(selected) await open(selected.conversation.id) }
  const rate = async (message:Message, rating:string) => { await request(`/api/iemoto-voice/messages/${message.id}/evaluations`, { method:'POST', body:JSON.stringify({rating}) }); setNotice(`「${rating}」を保存しました`) }
  const proposal = async () => { const json=await request('/api/iemoto-voice/style-proposals',{method:'POST',body:'{}'}); setNotice(`変更案を保存しました（本番未反映）: ${json.data.id}`) }
  return <div className="p-6 space-y-5">
    <div className="flex items-center justify-between"><div><h1 className="text-2xl font-bold">家元口調資料</h1><p className="text-sm text-gray-500">原本と加工データを分離し、評価からは変更案だけを作成します。</p></div><button onClick={proposal} className="rounded bg-green-600 px-4 py-2 text-white">スタイル変更案を作成</button></div>
    {notice && <div className="rounded bg-amber-50 p-3 text-sm text-amber-800">{notice}</div>}
    <select value={filter} onChange={e=>setFilter(e.target.value)} className="rounded border p-2"><option value="">すべて</option>{['IEMOTO_RAW','ASSISTANT_DRAFT','IEMOTO_APPROVED','IEMOTO_REVISED','IEMOTO_REJECTED','FACT_ONLY'].map(v=><option key={v}>{v}</option>)}</select>
    <div className="grid gap-5 lg:grid-cols-3"><div className="space-y-2">{rows.map(row=><button key={row.id} onClick={()=>open(row.id)} className="w-full rounded border bg-white p-3 text-left hover:border-green-500"><div className="font-medium">{row.title}</div><div className="text-xs text-gray-500">{row.category}・{row.message_count}発言 {row.pii_masked ? '・マスキング済' : ''}</div></button>)}</div>
    <div className="space-y-3 lg:col-span-2">{selected?.messages.map(message=><div key={message.id} className="rounded border bg-white p-4"><div className="mb-2 flex flex-wrap gap-2 text-xs"><span className="rounded bg-gray-100 px-2 py-1">{message.role}</span><select value={message.classification} onChange={e=>update(message,{classification:e.target.value})} className="rounded border px-2">{['IEMOTO_RAW','ASSISTANT_DRAFT','IEMOTO_APPROVED','IEMOTO_REVISED','IEMOTO_REJECTED','FACT_ONLY'].map(v=><option key={v}>{v}</option>)}</select><label><input type="checkbox" checked={Boolean(message.use_for_style)} onChange={e=>update(message,{useForStyle:e.target.checked})}/> 口調資料に使用</label>{message.pii_masked ? <span className="text-amber-700">個人情報マスキング済</span>:null}</div><p className="whitespace-pre-wrap text-sm">{message.content}</p><div className="mt-3 flex flex-wrap gap-1">{ratings.map(v=><button key={v} onClick={()=>rate(message,v)} className="rounded border px-2 py-1 text-xs hover:bg-gray-50">{v}</button>)}</div></div>)}</div></div>
  </div>
}
