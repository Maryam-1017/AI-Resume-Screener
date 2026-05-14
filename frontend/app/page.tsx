'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'

// ─── Types ──────────────────────────────────────────────────────────────────
type GitHubCheckResult = {
  url: string; exists: boolean
  repo_count?: number; top_languages?: string[]
}
type ScreeningResult = {
  candidate_name: string; score: number
  strengths: string[]; gaps: string[]
  experience_match: 'strong' | 'partial' | 'weak'
  recommendation: 'hire' | 'maybe' | 'pass'
  summary: string; github_check?: GitHubCheckResult
}
type Phase = 'idle' | 'loading' | 'result' | 'error'
type Tab = 'single' | 'batch'

// ─── Constants ───────────────────────────────────────────────────────────────
const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const STEPS = ['Parsing résumé…', 'Analyzing candidate fit…', 'Verifying GitHub…', 'Generating report…']

const REC = {
  hire:  { label: 'HIRE',  bg: 'linear-gradient(135deg,#059669,#10b981)', shadow: '#10b98155', text: '#d1fae5' },
  maybe: { label: 'MAYBE', bg: 'linear-gradient(135deg,#b45309,#f59e0b)', shadow: '#f59e0b55', text: '#fef3c7' },
  pass:  { label: 'PASS',  bg: 'linear-gradient(135deg,#b91c1c,#ef4444)', shadow: '#ef444455', text: '#fee2e2' },
}

const scoreColor = (s: number) => s >= 8 ? '#10b981' : s >= 5 ? '#f59e0b' : '#ef4444'
const scoreBg    = (s: number) => s >= 8 ? 'rgba(16,185,129,0.1)' : s >= 5 ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)'
const scoreBorder= (s: number) => s >= 8 ? 'rgba(16,185,129,0.3)' : s >= 5 ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.3)'

const ORBS = [
  { x:'5%',  y:'10%', s:600, c:'#4f46e5', o:0.22, d:10 },
  { x:'70%', y:'3%',  s:450, c:'#7c3aed', o:0.18, d:14 },
  { x:'85%', y:'55%', s:500, c:'#1d4ed8', o:0.15, d:11 },
  { x:'10%', y:'65%', s:400, c:'#0891b2', o:0.14, d:16 },
  { x:'45%', y:'38%', s:350, c:'#6d28d9', o:0.10, d:9  },
]

const FEATURES = [
  { icon: '⚡', label: 'Groq LLaMA-3.3' },
  { icon: '📄', label: 'PDF & Word' },
  { icon: '🐙', label: 'GitHub Verified' },
  { icon: '📊', label: 'Score 1–10' },
  { icon: '📑', label: 'PDF Report' },
]

// ─── Hooks ───────────────────────────────────────────────────────────────────
function useTilt() {
  const ref = useRef<HTMLDivElement>(null)
  const move = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top)  / r.height - 0.5
    el.style.transform = `perspective(800px) rotateX(${-y*12}deg) rotateY(${x*12}deg) scale3d(1.015,1.015,1.015)`
    el.style.transition = 'transform 0.08s linear'
  }
  const leave = () => {
    if (ref.current) {
      ref.current.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg) scale3d(1,1,1)'
      ref.current.style.transition = 'transform 0.55s cubic-bezier(0.23,1,0.32,1)'
    }
  }
  return { ref, move, leave }
}

// ─── Background ──────────────────────────────────────────────────────────────
function Background() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0" style={{ background: '#06060f' }}>
      {ORBS.map((o,i) => (
        <motion.div key={i} className="absolute rounded-full"
          style={{ left:o.x, top:o.y, width:o.s, height:o.s, background:o.c, opacity:o.o, filter:'blur(100px)' }}
          animate={{ x:[0,30,-20,10,0], y:[0,-25,15,-8,0], scale:[1,1.15,0.92,1.08,1] }}
          transition={{ duration:o.d, repeat:Infinity, ease:'easeInOut' }}
        />
      ))}
      <div className="absolute inset-0 opacity-[0.04]" style={{
        backgroundImage:'linear-gradient(rgba(255,255,255,.6) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.6) 1px,transparent 1px)',
        backgroundSize:'64px 64px'
      }}/>
    </div>
  )
}

// ─── Atom loader ─────────────────────────────────────────────────────────────
function AtomLoader({ status }: { status: string }) {
  return (
    <div className="flex flex-col items-center gap-8 py-20">
      <div className="relative w-28 h-28" style={{ perspective: 500 }}>
        <motion.div className="absolute rounded-full"
          style={{ width:14,height:14,top:'50%',left:'50%',marginTop:-7,marginLeft:-7,
            background:'radial-gradient(circle,#c4b5fd,#818cf8)',boxShadow:'0 0 20px #818cf8' }}
          animate={{ scale:[1,1.5,1], opacity:[0.8,1,0.8] }}
          transition={{ duration:1.5, repeat:Infinity }}
        />
        {[{rx:0,ry:0,c:'#818cf8',d:1.4},{rx:60,ry:60,c:'#a78bfa',d:2},{rx:-60,ry:30,c:'#22d3ee',d:2.6}].map((r,i)=>(
          <motion.div key={i} className="absolute inset-0 rounded-full"
            style={{ border:`2px solid ${r.c}60`, rotateX:r.rx, rotateY:r.ry }}
            animate={{ rotateZ:360 }}
            transition={{ duration:r.d, repeat:Infinity, ease:'linear' }}
          />
        ))}
      </div>
      <div className="text-center space-y-3">
        <motion.p key={status} initial={{opacity:0,y:6}} animate={{opacity:1,y:0}}
          className="font-medium text-sm" style={{ color:'#a5b4fc' }}>
          {status}
        </motion.p>
        <div className="flex gap-2 justify-center">
          {[0,1,2].map(i=>(
            <motion.div key={i} className="w-1.5 h-1.5 rounded-full" style={{ background:'#6366f1' }}
              animate={{ opacity:[0.2,1,0.2], y:[0,-5,0] }}
              transition={{ duration:1.1, repeat:Infinity, delay:i*0.18 }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Score ring ───────────────────────────────────────────────────────────────
function ScoreRing({ score }: { score: number }) {
  const r=52, circ=2*Math.PI*r, color=scoreColor(score)
  return (
    <div className="relative w-36 h-36">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="8"/>
        <motion.circle cx="60" cy="60" r={r} fill="none" stroke={color}
          strokeWidth="8" strokeLinecap="round" strokeDasharray={circ}
          initial={{ strokeDashoffset:circ }}
          animate={{ strokeDashoffset:circ-(score/10)*circ }}
          transition={{ duration:1.8, ease:'easeOut', delay:0.3 }}
          style={{ filter:`drop-shadow(0 0 8px ${color})` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.span className="text-5xl font-black leading-none" style={{ color }}
          initial={{scale:0,opacity:0}} animate={{scale:1,opacity:1}}
          transition={{type:'spring',stiffness:200,delay:0.5}}>
          {score}
        </motion.span>
        <span className="text-xs font-semibold" style={{ color:'rgba(255,255,255,0.3)' }}>/10</span>
      </div>
    </div>
  )
}

// ─── Skill tags ───────────────────────────────────────────────────────────────
function SkillTags({ text }: { text: string }) {
  const TECH = ['python','javascript','typescript','react','next','node','fastapi','django','docker','kubernetes',
    'aws','gcp','azure','sql','postgresql','mongodb','redis','git','ci/cd','machine learning','deep learning',
    'pytorch','tensorflow','llm','openai','langchain','java','c++','rust','go','php','vue','angular','flutter']
  const found = TECH.filter(t => text.toLowerCase().includes(t)).slice(0,12)
  if (!found.length) return null
  return (
    <motion.div {...card(6)} className="glass rounded-2xl p-5">
      <p className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{ color:'rgba(255,255,255,0.35)' }}>
        Detected Skills
      </p>
      <div className="flex flex-wrap gap-2">
        {found.map((s,i)=>(
          <motion.span key={s} initial={{opacity:0,scale:0.8}} animate={{opacity:1,scale:1}}
            transition={{delay:0.7+i*0.05}}
            className="rounded-lg px-3 py-1 text-xs font-semibold capitalize"
            style={{ background:'rgba(99,102,241,0.15)', color:'#a5b4fc', border:'1px solid rgba(99,102,241,0.25)' }}>
            {s}
          </motion.span>
        ))}
      </div>
    </motion.div>
  )
}

// ─── Card animation helper ────────────────────────────────────────────────────
const card = (i: number) => ({
  initial:{ opacity:0, y:28, scale:0.97 },
  animate:{ opacity:1, y:0, scale:1 },
  transition:{ delay:i*0.11, duration:0.45, ease:'easeOut' as const },
})

// ─── Dropzone ─────────────────────────────────────────────────────────────────
function FileDropzone({ file, onFile, multi=false }:{ file:File|null; onFile:(f:File)=>void; multi?:boolean }) {
  const onDrop = useCallback((a:File[])=>{ if(a[0]) onFile(a[0]) },[onFile])
  const { getRootProps,getInputProps,isDragActive } = useDropzone({
    onDrop, maxFiles:1,
    accept:{ 'application/pdf':['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['.docx'] },
  })
  return (
    <div {...getRootProps()} className="rounded-2xl cursor-pointer relative overflow-hidden" style={{
      background: file?'rgba(16,185,129,0.08)':isDragActive?'rgba(99,102,241,0.12)':'rgba(255,255,255,0.04)',
      border:`1.5px dashed ${file?'#10b981':isDragActive?'#818cf8':'rgba(255,255,255,0.18)'}`,
      transition:'all 0.25s ease',
    }}>
      <input {...getInputProps()}/>
      {isDragActive&&(
        <motion.div className="absolute inset-0 rounded-2xl pointer-events-none"
          style={{ boxShadow:'inset 0 0 40px rgba(99,102,241,0.2)' }}
          animate={{ opacity:[0.4,1,0.4] }} transition={{ duration:0.9,repeat:Infinity }}/>
      )}
      <div className="flex flex-col items-center justify-center gap-3 py-10 px-6 text-center">
        {file ? (
          <>
            <motion.div initial={{scale:0,rotate:-180}} animate={{scale:1,rotate:0}}
              transition={{type:'spring',stiffness:220}}
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{ background:'rgba(16,185,129,0.18)', border:'1.5px solid #10b98155' }}>
              <svg className="w-6 h-6" style={{color:'#34d399'}} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/>
              </svg>
            </motion.div>
            <p className="text-sm font-semibold" style={{color:'#6ee7b7'}}>{file.name}</p>
            <p className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>Click or drop to replace</p>
          </>
        ):(
          <>
            <motion.div animate={{y:[0,-7,0]}} transition={{duration:2.5,repeat:Infinity,ease:'easeInOut'}}
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{ background:'rgba(99,102,241,0.14)', border:'1.5px solid rgba(99,102,241,0.35)' }}>
              <svg className="w-6 h-6" style={{color:'#818cf8'}} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </motion.div>
            <div>
              <p className="text-sm font-medium" style={{color:'rgba(255,255,255,0.75)'}}>
                {isDragActive?'Drop it here…':'Drag & drop, or click to browse'}
              </p>
              <p className="text-xs mt-1" style={{color:'rgba(255,255,255,0.3)'}}>PDF or Word (.docx) · max 10 MB</p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Results panel ────────────────────────────────────────────────────────────
function ResultsPanel({ result, onReset }:{ result:ScreeningResult; onReset:()=>void }) {
  const tilt = useTilt()
  const color = scoreColor(result.score)
  const rec = REC[result.recommendation]
  const [copied,setCopied] = useState(false)
  const copySummary = () => {
    navigator.clipboard.writeText(result.summary)
    setCopied(true); setTimeout(()=>setCopied(false),2000)
  }

  const matchIcons = { strong:'🟢 Strong', partial:'🟡 Partial', weak:'🔴 Weak' }

  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} className="space-y-4">

      {/* Nav */}
      <div className="flex items-center justify-between mb-1">
        <motion.h2 initial={{x:-16,opacity:0}} animate={{x:0,opacity:1}}
          className="text-xl font-bold text-white truncate">
          {result.candidate_name}
        </motion.h2>
        <motion.button initial={{x:16,opacity:0}} animate={{x:0,opacity:1}}
          onClick={onReset} whileHover={{x:-2}}
          className="ml-4 flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all"
          style={{ background:'rgba(255,255,255,0.07)', color:'rgba(255,255,255,0.5)', border:'1px solid rgba(255,255,255,0.1)' }}
          onMouseEnter={e=>{e.currentTarget.style.color='#818cf8';e.currentTarget.style.borderColor='#6366f140'}}
          onMouseLeave={e=>{e.currentTarget.style.color='rgba(255,255,255,0.5)';e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'}}>
          ← New screening
        </motion.button>
      </div>

      {/* Hero score card */}
      <motion.div {...card(0)} ref={tilt.ref} onMouseMove={tilt.move} onMouseLeave={tilt.leave}
        className="tilt-card glass-strong rounded-3xl p-7"
        style={{ border:`1px solid ${color}30`, boxShadow:`0 0 60px ${color}12` }}>
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-6">
            <ScoreRing score={result.score}/>
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-widest" style={{color:'rgba(255,255,255,0.35)'}}>
                Overall Fit
              </p>
              <div className="w-48 h-2 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.08)'}}>
                <motion.div className="h-full rounded-full" style={{background:`linear-gradient(90deg,${color},${color}aa)`}}
                  initial={{width:0}} animate={{width:`${result.score*10}%`}}
                  transition={{duration:1.6,ease:'easeOut',delay:0.4}}/>
              </div>
              <p className="text-xs" style={{color:'rgba(255,255,255,0.4)'}}>
                {matchIcons[result.experience_match]} experience match
              </p>
            </div>
          </div>
          <motion.div initial={{rotateY:-90,opacity:0}} animate={{rotateY:0,opacity:1}}
            transition={{type:'spring',stiffness:100,delay:0.8}}
            className="flex flex-col items-center gap-2"
            style={{transformStyle:'preserve-3d'}}>
            <div className="px-9 py-3 rounded-2xl font-black text-xl tracking-[0.18em]"
              style={{background:rec.bg,boxShadow:`0 0 40px ${rec.shadow},0 4px 20px ${rec.shadow}`,color:'white'}}>
              {rec.label}
            </div>
            <p className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>Recommendation</p>
          </motion.div>
        </div>
      </motion.div>

      {/* Strengths + Gaps */}
      <div className="grid grid-cols-2 gap-4">
        {(['strengths','gaps'] as const).map((f,fi)=>(
          <motion.div key={f} {...card(fi+1)} className="glass rounded-2xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest mb-3"
              style={{color:f==='strengths'?'#34d399':'#f87171'}}>
              {f==='strengths'?'✦ Strengths':'✦ Gaps'}
            </p>
            <ul className="space-y-2.5">
              {result[f].map((item,i)=>(
                <motion.li key={i}
                  initial={{opacity:0,x:f==='strengths'?-10:10}} animate={{opacity:1,x:0}}
                  transition={{delay:0.55+i*0.1}}
                  className="flex items-start gap-2 text-sm leading-snug"
                  style={{color:'rgba(255,255,255,0.78)'}}>
                  <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{background:f==='strengths'?'#34d399':'#f87171'}}/>
                  {item}
                </motion.li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>

      {/* Skills */}
      <SkillTags text={result.summary + result.strengths.join(' ')}/>

      {/* Summary */}
      <motion.div {...card(4)} className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-bold uppercase tracking-widest" style={{color:'rgba(255,255,255,0.35)'}}>
            AI Summary
          </p>
          <motion.button onClick={copySummary} whileHover={{scale:1.05}} whileTap={{scale:0.95}}
            className="text-xs px-3 py-1 rounded-lg flex items-center gap-1.5 transition-colors"
            style={{ background:'rgba(99,102,241,0.15)', color:copied?'#34d399':'#a5b4fc', border:'1px solid rgba(99,102,241,0.25)' }}>
            {copied?'✓ Copied':'Copy'}
          </motion.button>
        </div>
        <p className="text-sm leading-relaxed" style={{color:'rgba(255,255,255,0.75)'}}>{result.summary}</p>
      </motion.div>

      {/* GitHub */}
      {result.github_check&&(
        <motion.div {...card(5)} className="glass rounded-2xl p-5">
          <p className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{color:'rgba(255,255,255,0.35)'}}>
            GitHub Profile
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
              style={{ background:result.github_check.exists?'rgba(16,185,129,0.14)':'rgba(239,68,68,0.14)',
                color:result.github_check.exists?'#34d399':'#f87171',
                border:`1px solid ${result.github_check.exists?'#34d39930':'#f8717130'}` }}>
              <span className="h-1.5 w-1.5 rounded-full"
                style={{background:result.github_check.exists?'#34d399':'#f87171'}}/>
              {result.github_check.exists?'Verified':'Not found'}
            </span>
            <a href={result.github_check.url} target="_blank" rel="noopener noreferrer"
              className="text-sm hover:underline truncate max-w-[14rem]" style={{color:'#818cf8'}}>
              {result.github_check.url}
            </a>
            {result.github_check.repo_count!=null&&(
              <span className="text-xs px-2.5 py-1 rounded-lg"
                style={{background:'rgba(255,255,255,0.06)',color:'rgba(255,255,255,0.5)'}}>
                {result.github_check.repo_count} repos
              </span>
            )}
            {result.github_check.top_languages?.map(l=>(
              <span key={l} className="rounded-lg px-2.5 py-1 text-xs font-medium"
                style={{background:'rgba(99,102,241,0.14)',color:'#a5b4fc',border:'1px solid rgba(99,102,241,0.22)'}}>
                {l}
              </span>
            ))}
          </div>
        </motion.div>
      )}

      {/* Actions */}
      <motion.div {...card(7)} className="grid grid-cols-2 gap-3 pt-1">
        <motion.a href={`${API}/report/${encodeURIComponent(result.candidate_name)}`} download
          whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white"
          style={{background:'linear-gradient(135deg,#4338ca,#6d28d9,#0891b2)',boxShadow:'0 0 40px rgba(99,102,241,0.35)'}}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          Download PDF
        </motion.a>
        <motion.button onClick={onReset}
          whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="rounded-2xl py-3.5 text-sm font-semibold"
          style={{background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.12)',color:'rgba(255,255,255,0.7)'}}>
          Screen Another
        </motion.button>
      </motion.div>
    </motion.div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Page() {
  const [phase,    setPhase]    = useState<Phase>('idle')
  const [tab,      setTab]      = useState<Tab>('single')
  const [jobDesc,  setJobDesc]  = useState('')
  const [file,     setFile]     = useState<File | null>(null)
  const [result,   setResult]   = useState<ScreeningResult | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [stepIdx,  setStepIdx]  = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null)
  const formTilt = useTilt()

  useEffect(()=>{
    if(phase==='loading'){
      setStepIdx(0)
      timerRef.current = setInterval(()=>setStepIdx(i=>Math.min(i+1,STEPS.length-1)),1700)
    } else { if(timerRef.current) clearInterval(timerRef.current) }
    return ()=>{ if(timerRef.current) clearInterval(timerRef.current) }
  },[phase])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if(!file||!jobDesc.trim()) return
    setPhase('loading'); setError(null)
    try {
      const body = new FormData()
      body.append('pdf_file', file)
      body.append('job_description', jobDesc.trim())
      const res = await fetch(`${API}/screen`,{method:'POST',body})
      if(!res.ok){ const p=await res.json().catch(()=>({detail:res.statusText})); throw new Error(p?.detail??`HTTP ${res.status}`) }
      setResult(await res.json()); setPhase('result')
    } catch(err){ setError(err instanceof Error?err.message:'Unexpected error.'); setPhase('error') }
  }
  const reset = ()=>{ setPhase('idle');setResult(null);setError(null);setFile(null);setJobDesc('') }

  return (
    <div style={{ minHeight:'100vh', background:'#06060f' }}>
      <Background/>

      <div className="relative z-10 min-h-screen flex flex-col">

        {/* ── Header */}
        <motion.header initial={{y:-24,opacity:0}} animate={{y:0,opacity:1}}
          className="sticky top-0 z-20"
          style={{background:'rgba(6,6,15,0.85)',backdropFilter:'blur(24px)',borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
          <div className="mx-auto max-w-2xl px-4 py-3.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <motion.div animate={{rotateY:[0,360]}} transition={{duration:9,repeat:Infinity,ease:'linear'}}
                className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{background:'linear-gradient(135deg,#4f46e5,#7c3aed)',boxShadow:'0 0 20px #6366f166',transformStyle:'preserve-3d'}}>
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                </svg>
              </motion.div>
              <div>
                <p className="text-sm font-black gradient-text leading-none">AI Resume Screener</p>
                <p className="text-[10px] mt-0.5" style={{color:'rgba(255,255,255,0.3)'}}>Groq · LLaMA-3.3-70b</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="hidden sm:flex items-center gap-1.5">
                <motion.div className="w-1.5 h-1.5 rounded-full" style={{background:'#10b981'}}
                  animate={{scale:[1,1.6,1],opacity:[1,0.4,1]}} transition={{duration:2,repeat:Infinity}}/>
                <span className="text-xs font-semibold" style={{color:'#6ee7b7'}}>Live</span>
              </div>
            </div>
          </div>
        </motion.header>

        <main className="flex-1 mx-auto w-full max-w-2xl px-4 pb-12">
          <AnimatePresence mode="wait">

            {/* ── Results */}
            {phase==='result'&&result&&(
              <motion.div key="result" initial={{opacity:0,y:16}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}} className="pt-8">
                <ResultsPanel result={result} onReset={reset}/>
              </motion.div>
            )}

            {/* ── Form */}
            {(phase==='idle'||phase==='error')&&(
              <motion.div key="form" initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-12}}
                transition={{duration:0.45,ease:'easeOut'}}>

                {/* Hero section */}
                <div className="pt-12 pb-8 text-center">
                  <motion.div initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} transition={{delay:0.05}}
                    className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 mb-5 text-xs font-semibold"
                    style={{background:'rgba(99,102,241,0.15)',color:'#a5b4fc',border:'1px solid rgba(99,102,241,0.3)'}}>
                    ✦ Powered by Groq · sub-second inference
                  </motion.div>
                  <motion.h1 initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.1}}
                    className="text-4xl sm:text-5xl font-black leading-tight mb-3 gradient-text">
                    Screen Smarter.<br/>Hire Better.
                  </motion.h1>
                  <motion.p initial={{opacity:0}} animate={{opacity:1}} transition={{delay:0.18}}
                    className="text-sm max-w-md mx-auto leading-relaxed"
                    style={{color:'rgba(255,255,255,0.5)'}}>
                    AI-powered résumé screening with GitHub verification, skill detection, and downloadable PDF reports.
                  </motion.p>

                  {/* Feature pills */}
                  <motion.div initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{delay:0.24}}
                    className="flex flex-wrap justify-center gap-2 mt-5">
                    {FEATURES.map(f=>(
                      <span key={f.label} className="text-xs px-3 py-1.5 rounded-full font-medium"
                        style={{background:'rgba(255,255,255,0.06)',color:'rgba(255,255,255,0.6)',border:'1px solid rgba(255,255,255,0.1)'}}>
                        {f.icon} {f.label}
                      </span>
                    ))}
                  </motion.div>
                </div>

                {/* Tabs */}
                <motion.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={{delay:0.28}}
                  className="flex rounded-xl p-1 mb-5"
                  style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)'}}>
                  {(['single','batch'] as const).map(t=>(
                    <button key={t} onClick={()=>setTab(t)}
                      className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                      style={{
                        background:tab===t?'rgba(99,102,241,0.25)':'transparent',
                        color:tab===t?'#a5b4fc':'rgba(255,255,255,0.4)',
                        border:tab===t?'1px solid rgba(99,102,241,0.35)':'1px solid transparent',
                      }}>
                      {t==='single'?'📄 Single Résumé':'📦 Batch Upload'}
                    </button>
                  ))}
                </motion.div>

                <form onSubmit={submit} className="space-y-4">

                  {/* Job description */}
                  <motion.div ref={formTilt.ref} onMouseMove={formTilt.move} onMouseLeave={formTilt.leave}
                    initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.32}}
                    className="glass tilt-card rounded-2xl p-5">
                    <label className="block text-xs font-bold uppercase tracking-widest mb-3"
                      style={{color:'rgba(255,255,255,0.4)'}}>
                      Job Description
                    </label>
                    <textarea value={jobDesc} onChange={e=>setJobDesc(e.target.value)}
                      rows={tab==='batch'?4:6}
                      placeholder="Paste the full job description here…"
                      required minLength={10}
                      className="w-full resize-none rounded-xl px-4 py-3 text-sm outline-none"
                      style={{
                        background:'rgba(255,255,255,0.05)',
                        border:'1px solid rgba(255,255,255,0.1)',
                        color:'#f1f5f9',
                        caretColor:'#818cf8',
                      }}
                      onFocus={e=>{e.target.style.borderColor='rgba(99,102,241,0.5)';e.target.style.boxShadow='0 0 0 3px rgba(99,102,241,0.1)'}}
                      onBlur={e=>{e.target.style.borderColor='rgba(255,255,255,0.1)';e.target.style.boxShadow='none'}}
                    />
                  </motion.div>

                  {/* File upload */}
                  <motion.div className="glass rounded-2xl p-5"
                    initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.38}}>
                    <label className="block text-xs font-bold uppercase tracking-widest mb-3"
                      style={{color:'rgba(255,255,255,0.4)'}}>
                      {tab==='batch'?'Résumé Files (select multiple)':'Résumé File'}
                    </label>
                    {tab==='batch'?(
                      <div className="rounded-2xl p-5 text-center"
                        style={{background:'rgba(255,255,255,0.04)',border:'1.5px dashed rgba(255,255,255,0.18)'}}>
                        <p className="text-sm" style={{color:'rgba(255,255,255,0.5)'}}>
                          Use <code className="px-1.5 py-0.5 rounded text-xs" style={{background:'rgba(99,102,241,0.2)',color:'#a5b4fc'}}>
                            POST /batch
                          </code> API endpoint for batch processing.
                        </p>
                        <p className="text-xs mt-2" style={{color:'rgba(255,255,255,0.25)'}}>
                          Or switch to Single tab to screen one at a time.
                        </p>
                      </div>
                    ):(
                      <FileDropzone file={file} onFile={setFile}/>
                    )}
                  </motion.div>

                  {/* Error */}
                  <AnimatePresence>
                    {phase==='error'&&error&&(
                      <motion.div initial={{opacity:0,y:-6,scale:0.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0}}
                        className="flex items-start gap-3 rounded-2xl px-4 py-3.5 text-sm"
                        style={{background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',color:'#fca5a5'}}>
                        <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" clipRule="evenodd"
                            d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"/>
                        </svg>
                        {error}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Submit */}
                  <motion.button type="submit"
                    disabled={tab==='single'&&(!file||!jobDesc.trim())}
                    initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.44}}
                    whileHover={{scale:1.01,y:-1}} whileTap={{scale:0.98}}
                    className="w-full flex items-center justify-center gap-2.5 rounded-2xl py-4 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      background:'linear-gradient(135deg,#4338ca,#6d28d9 50%,#0891b2)',
                      boxShadow:'0 0 50px rgba(99,102,241,0.3),0 4px 24px rgba(99,102,241,0.2)',
                    }}>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/>
                    </svg>
                    Screen Candidate
                  </motion.button>
                </form>

                {/* Bottom hint */}
                <motion.p initial={{opacity:0}} animate={{opacity:1}} transition={{delay:0.55}}
                  className="text-center text-xs mt-6" style={{color:'rgba(255,255,255,0.2)'}}>
                  Results powered by LLaMA-3.3-70b on Groq · GitHub data via public API
                </motion.p>
              </motion.div>
            )}

            {/* ── Loading */}
            {phase==='loading'&&(
              <motion.div key="loading" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
                className="glass rounded-3xl mt-12">
                <AtomLoader status={STEPS[stepIdx]}/>
              </motion.div>
            )}

          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
