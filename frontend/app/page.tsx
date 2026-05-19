'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'

// ─── Types (unchanged) ───────────────────────────────────────────────────────
type GitHubCheckResult = { url: string; exists: boolean; repo_count?: number; top_languages?: string[] }
type ScreeningResult = {
  candidate_name: string; score: number; strengths: string[]; gaps: string[]
  experience_match: 'strong' | 'partial' | 'weak'; recommendation: 'hire' | 'maybe' | 'pass'
  summary: string; github_check?: GitHubCheckResult
}
type CandidateRanking = { rank: number; name: string; one_line_verdict: string; beats_next_because?: string | null }
type ComparisonResult = {
  recommended_hire: string; ranking: CandidateRanking[]
  panel_interview_shortlist: string[]; red_flags: Record<string, string>
  hiring_memo: string; job_description_summary: string; total_candidates: number
}
type CompareResponse = {
  individual_results: ScreeningResult[]; comparison: ComparisonResult | null
  screened_at: string; warning?: string
}
type Phase = 'idle' | 'loading' | 'result' | 'error'
type Tab   = 'single' | 'compare'

// ─── Constants ───────────────────────────────────────────────────────────────
const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const STEPS         = ['Parsing résumé…','Analyzing candidate fit…','Verifying GitHub…','Generating report…']
const COMPARE_STEPS = ['Parsing résumés…','Scoring candidates…','Running comparison analysis…','Building report…']

const REC = {
  hire:  { label:'HIRE',  bg:'linear-gradient(135deg,#059669,#10b981)', shadow:'0 0 32px rgba(16,185,129,0.65), 0 4px 20px rgba(16,185,129,0.4)' },
  maybe: { label:'MAYBE', bg:'linear-gradient(135deg,#b45309,#f59e0b)', shadow:'0 0 32px rgba(245,158,11,0.65), 0 4px 20px rgba(245,158,11,0.4)' },
  pass:  { label:'PASS',  bg:'linear-gradient(135deg,#b91c1c,#ef4444)', shadow:'0 0 32px rgba(239,68,68,0.65),  0 4px 20px rgba(239,68,68,0.4)'  },
}

const scoreColor = (s: number) => s >= 8 ? '#10b981' : s >= 5 ? '#f59e0b' : '#ef4444'
const scoreGrad  = (s: number) =>
  s >= 8 ? 'linear-gradient(135deg,#10b981,#34d399)'
         : s >= 5 ? 'linear-gradient(135deg,#f59e0b,#fbbf24)'
         : 'linear-gradient(135deg,#ef4444,#f87171)'
const scoreLabel = (s: number) => s >= 8 ? '🟢 Strong' : s >= 5 ? '🟡 Partial' : '🔴 Weak'

const ORBS = [
  { x:'5%',  y:'5%',  s:700, c:'#4f46e5', o:0.20, d:10 },
  { x:'68%', y:'2%',  s:500, c:'#7c3aed', o:0.18, d:14 },
  { x:'82%', y:'52%', s:550, c:'#5b21b6', o:0.15, d:11 },
  { x:'8%',  y:'60%', s:450, c:'#0891b2', o:0.12, d:16 },
  { x:'42%', y:'35%', s:380, c:'#6d28d9', o:0.09, d:9  },
]

const FEATURES = [
  { icon:'⚡', label:'Groq LLaMA-3.3', color:'#8B5CF6' },
  { icon:'📄', label:'PDF & Word',      color:'#3B82F6' },
  { icon:'🐙', label:'GitHub Verified', color:'#10B981' },
  { icon:'📊', label:'Score 1–10',      color:'#F59E0B' },
  { icon:'⚖️', label:'Compare Mode',   color:'#06B6D4' },
]

const STATS = [
  { target:2.3, suffix:'s', label:'avg screening time', decimal:1 },
  { target:94,  suffix:'%', label:'accuracy',           decimal:0 },
  { target:10,  suffix:'x', label:'faster than manual', decimal:0 },
]
const STAT_COLORS = ['#8B5CF6','#10B981','#06B6D4']

// ─── Hooks (unchanged) ───────────────────────────────────────────────────────
function useTilt() {
  const ref = useRef<HTMLDivElement>(null)
  const move = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top)  / r.height - 0.5
    el.style.transform = `perspective(800px) rotateX(${-y*10}deg) rotateY(${x*10}deg) scale3d(1.012,1.012,1.012)`
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

// ─── Background ───────────────────────────────────────────────────────────────
function Background() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0"
      style={{ background:'linear-gradient(160deg,#0F0F1A 0%,#1A0F2E 100%)' }}>
      {ORBS.map((o,i) => (
        <motion.div key={i} className="absolute rounded-full"
          style={{ left:o.x, top:o.y, width:o.s, height:o.s, background:o.c, opacity:o.o, filter:'blur(110px)' }}
          animate={{ x:[0,25,-18,8,0], y:[0,-22,14,-6,0], scale:[1,1.12,0.93,1.07,1] }}
          transition={{ duration:o.d, repeat:Infinity, ease:'easeInOut' }}
        />
      ))}
      {/* Subtle grid */}
      <div className="absolute inset-0" style={{
        backgroundImage:'linear-gradient(rgba(139,92,246,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,0.04) 1px,transparent 1px)',
        backgroundSize:'60px 60px',
      }}/>
    </div>
  )
}

// ─── Animated counter stats ───────────────────────────────────────────────────
function CounterStats() {
  const [counts, setCounts] = useState(STATS.map(() => 0))
  useEffect(() => {
    const start = Date.now()
    const dur = 1600
    let raf: number
    const tick = () => {
      const p = Math.min((Date.now() - start) / dur, 1)
      const e = 1 - Math.pow(1 - p, 3) // ease-out cubic
      setCounts(STATS.map(s => s.target * e))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    const t = setTimeout(() => { raf = requestAnimationFrame(tick) }, 700)
    return () => { clearTimeout(t); cancelAnimationFrame(raf) }
  }, [])

  return (
    <motion.div initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} transition={{delay:0.45}}
      className="flex items-center justify-center gap-0 mt-8 flex-wrap">
      {STATS.map((s, i) => (
        <div key={i} className="flex items-center">
          <div className="px-6 text-center">
            <div className="text-2xl font-black tracking-tight" style={{ color: STAT_COLORS[i] }}>
              {counts[i].toFixed(s.decimal)}{s.suffix}
            </div>
            <div className="text-xs mt-0.5" style={{ color:'rgba(255,255,255,0.4)' }}>{s.label}</div>
          </div>
          {i < STATS.length - 1 && <div className="stat-divider"/>}
        </div>
      ))}
    </motion.div>
  )
}

// ─── Atom loader (unchanged) ──────────────────────────────────────────────────
function AtomLoader({ status }: { status: string }) {
  return (
    <div className="flex flex-col items-center gap-8 py-20">
      <div className="relative w-28 h-28" style={{ perspective:500 }}>
        <motion.div className="absolute rounded-full"
          style={{ width:14,height:14,top:'50%',left:'50%',marginTop:-7,marginLeft:-7,
            background:'radial-gradient(circle,#c4b5fd,#8B5CF6)',boxShadow:'0 0 20px #8B5CF6' }}
          animate={{ scale:[1,1.5,1],opacity:[0.8,1,0.8] }} transition={{ duration:1.5,repeat:Infinity }}
        />
        {[{rx:0,ry:0,c:'#8B5CF6',d:1.4},{rx:60,ry:60,c:'#a78bfa',d:2},{rx:-60,ry:30,c:'#06B6D4',d:2.6}].map((r,i)=>(
          <motion.div key={i} className="absolute inset-0 rounded-full"
            style={{ border:`2px solid ${r.c}60`, rotateX:r.rx, rotateY:r.ry }}
            animate={{ rotateZ:360 }} transition={{ duration:r.d, repeat:Infinity, ease:'linear' }}
          />
        ))}
      </div>
      <div className="text-center space-y-3">
        <motion.p key={status} initial={{opacity:0,y:6}} animate={{opacity:1,y:0}}
          className="font-medium text-sm" style={{ color:'#c4b5fd' }}>
          {status}
        </motion.p>
        <div className="flex gap-2 justify-center">
          {[0,1,2].map(i=>(
            <motion.div key={i} className="w-1.5 h-1.5 rounded-full" style={{ background:'#8B5CF6' }}
              animate={{ opacity:[0.2,1,0.2],y:[0,-5,0] }}
              transition={{ duration:1.1,repeat:Infinity,delay:i*0.18 }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Big score display ────────────────────────────────────────────────────────
function BigScore({ score }: { score: number }) {
  const color = scoreColor(score)
  const grad  = scoreGrad(score)
  return (
    <div className="flex flex-col items-center">
      <motion.div
        initial={{ scale:0.5, opacity:0 }} animate={{ scale:1, opacity:1 }}
        transition={{ type:'spring', stiffness:140, delay:0.3 }}
        className="leading-none font-black"
        style={{ fontSize:'96px', background:grad, WebkitBackgroundClip:'text',
          WebkitTextFillColor:'transparent', backgroundClip:'text',
          filter:`drop-shadow(0 0 24px ${color}88)` }}>
        {score}
      </motion.div>
      <span className="text-sm font-semibold mt-1" style={{ color:'rgba(255,255,255,0.35)' }}>out of 10</span>
    </div>
  )
}

// ─── Card animation helper ────────────────────────────────────────────────────
const card = (i: number) => ({
  initial:   { opacity:0, y:24, scale:0.97 },
  animate:   { opacity:1, y:0,  scale:1    },
  transition:{ delay:i*0.1, duration:0.45, ease:'easeOut' as const },
})

// ─── Feature badge ────────────────────────────────────────────────────────────
function FeatureBadge({ icon, label, color }: { icon:string; label:string; color:string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold"
      style={{
        padding:'6px 14px 6px 11px',
        borderRadius:'10px',
        background:`${color}0d`,
        border:`1px solid ${color}28`,
        borderLeftColor:color,
        borderLeftWidth:'3px',
        color:'rgba(255,255,255,0.75)',
      }}>
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  )
}

// ─── Single-file dropzone ─────────────────────────────────────────────────────
function FileDropzone({ file, onFile }: { file: File|null; onFile:(f:File)=>void }) {
  const onDrop = useCallback((a:File[])=>{ if(a[0]) onFile(a[0]) },[onFile])
  const { getRootProps,getInputProps,isDragActive } = useDropzone({
    onDrop, maxFiles:1,
    accept:{ 'application/pdf':['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['.docx'] },
  })
  return (
    <div {...getRootProps()} className="rounded-2xl cursor-pointer relative overflow-hidden transition-all"
      style={{
        background: file?'rgba(139,92,246,0.06)':isDragActive?'rgba(139,92,246,0.1)':'rgba(15,10,30,0.5)',
        border:`2px dashed ${file?'rgba(139,92,246,0.7)':isDragActive?'#8B5CF6':'rgba(139,92,246,0.3)'}`,
        boxShadow: isDragActive?'0 0 20px rgba(139,92,246,0.25), inset 0 0 20px rgba(139,92,246,0.08)':'none',
        transition:'all 0.25s ease',
      }}>
      <input {...getInputProps()}/>
      {isDragActive&&(
        <motion.div className="absolute inset-0 rounded-2xl pointer-events-none"
          style={{ background:'rgba(139,92,246,0.05)' }}
          animate={{ opacity:[0.5,1,0.5] }} transition={{ duration:0.8,repeat:Infinity }}/>
      )}
      <div className="flex flex-col items-center justify-center gap-3 py-10 px-6 text-center">
        {file ? (
          <>
            <motion.div initial={{scale:0,rotate:-180}} animate={{scale:1,rotate:0}}
              transition={{type:'spring',stiffness:220}}
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{ background:'rgba(139,92,246,0.2)', border:'1.5px solid rgba(139,92,246,0.5)' }}>
              <svg className="w-6 h-6" style={{color:'#c4b5fd'}} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/>
              </svg>
            </motion.div>
            <p className="text-sm font-semibold" style={{color:'#c4b5fd'}}>{file.name}</p>
            <p className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>Click or drop to replace</p>
          </>
        ):(
          <>
            <motion.div animate={{y:[0,-6,0]}} transition={{duration:2.5,repeat:Infinity,ease:'easeInOut'}}
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{ background:'rgba(139,92,246,0.12)', border:'1.5px solid rgba(139,92,246,0.35)' }}>
              <svg className="w-6 h-6" style={{color:'#8B5CF6'}} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </motion.div>
            <p className="text-sm font-medium" style={{color:'rgba(255,255,255,0.7)'}}>
              {isDragActive?'Drop it here…':'Drag & drop your résumé, or click to browse'}
            </p>
            <p className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>PDF or Word (.docx) · max 10 MB</p>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Multi-file dropzone (logic unchanged, visuals updated) ───────────────────
function MultiFileDropzone({ files, onFiles }: { files: File[]; onFiles:(f:File[])=>void }) {
  const onDrop = useCallback((accepted: File[]) => {
    const merged = [...files, ...accepted]
    const unique = Array.from(new Map(merged.map(f => [f.name, f])).values())
    onFiles(unique.slice(0, 10))
  }, [files, onFiles])
  const { getRootProps,getInputProps,isDragActive } = useDropzone({
    onDrop, multiple:true, maxFiles:10, accept:{ 'application/pdf':['.pdf'] },
  })
  const remove = (name: string) => onFiles(files.filter(f => f.name !== name))
  const atMin = files.length >= 2, atMax = files.length >= 10

  return (
    <div>
      <div {...getRootProps()} className="rounded-2xl cursor-pointer relative overflow-hidden"
        style={{
          background: isDragActive?'rgba(139,92,246,0.1)':atMin?'rgba(139,92,246,0.06)':'rgba(15,10,30,0.5)',
          border:`2px dashed ${isDragActive?'#8B5CF6':atMin?'rgba(139,92,246,0.6)':'rgba(139,92,246,0.3)'}`,
          boxShadow: isDragActive?'0 0 20px rgba(139,92,246,0.2)':'none',
          transition:'all 0.25s ease',
        }}>
        <input {...getInputProps()}/>
        {isDragActive&&(
          <motion.div className="absolute inset-0 rounded-2xl pointer-events-none"
            style={{ background:'rgba(139,92,246,0.05)' }}
            animate={{ opacity:[0.5,1,0.5] }} transition={{ duration:0.8,repeat:Infinity }}/>
        )}
        <div className="flex flex-col items-center gap-3 py-8 px-6 text-center">
          <motion.div animate={{ y:[0,-5,0] }} transition={{ duration:2.5,repeat:Infinity,ease:'easeInOut' }}
            className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background:'rgba(139,92,246,0.12)', border:'1.5px solid rgba(139,92,246,0.35)' }}>
            <svg className="w-5 h-5" style={{color:'#8B5CF6'}} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
            </svg>
          </motion.div>
          <div>
            <p className="text-sm font-medium" style={{color:'rgba(255,255,255,0.7)'}}>
              {isDragActive?'Drop PDFs here…':atMax?'10 files maximum reached':'Drop PDFs here, or click to select'}
            </p>
            <p className="text-xs mt-1" style={{color:'rgba(255,255,255,0.35)'}}>
              {files.length} / 10 files · need at least 2 to compare
            </p>
          </div>
        </div>
      </div>
      <AnimatePresence>
        {files.length > 0 && (
          <motion.div initial={{opacity:0,height:0}} animate={{opacity:1,height:'auto'}} exit={{opacity:0,height:0}}
            className="flex flex-wrap gap-2 mt-3 overflow-hidden">
            {files.map((f,i)=>(
              <motion.div key={f.name}
                initial={{opacity:0,scale:0.85,x:-8}} animate={{opacity:1,scale:1,x:0}}
                exit={{opacity:0,scale:0.85,x:8}} transition={{delay:i*0.04}}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium max-w-[200px]"
                style={{ background:'rgba(139,92,246,0.12)',color:'#c4b5fd',border:'1px solid rgba(139,92,246,0.3)' }}>
                <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <span className="truncate">{f.name}</span>
                <button type="button" onClick={e=>{ e.stopPropagation(); remove(f.name) }}
                  className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
                  style={{color:'rgba(196,181,253,0.5)'}}
                  onMouseEnter={e=>(e.currentTarget.style.color='#f87171')}
                  onMouseLeave={e=>(e.currentTarget.style.color='rgba(196,181,253,0.5)')}>×</button>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── SkillTags (logic unchanged, visuals updated) ─────────────────────────────
function SkillTags({ text }: { text: string }) {
  const TECH = ['python','javascript','typescript','react','next','node','fastapi','django','docker','kubernetes',
    'aws','gcp','azure','sql','postgresql','mongodb','redis','git','machine learning','pytorch','tensorflow',
    'llm','openai','langchain','java','c++','rust','go','vue','angular','flutter']
  const found = TECH.filter(t => text.toLowerCase().includes(t)).slice(0,12)
  if (!found.length) return null
  return (
    <motion.div {...card(6)} className="glass p-5">
      <p className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{ color:'rgba(255,255,255,0.3)' }}>
        Detected Skills
      </p>
      <div className="flex flex-wrap gap-2">
        {found.map((s,i)=>(
          <motion.span key={s} initial={{opacity:0,scale:0.8}} animate={{opacity:1,scale:1}}
            transition={{delay:0.6+i*0.05}}
            className="rounded-lg px-3 py-1 text-xs font-semibold capitalize"
            style={{ background:'rgba(139,92,246,0.12)',color:'#c4b5fd',border:'1px solid rgba(139,92,246,0.25)' }}>
            {s}
          </motion.span>
        ))}
      </div>
    </motion.div>
  )
}

// ─── Single results panel ─────────────────────────────────────────────────────
function ResultsPanel({ result, onReset }: { result: ScreeningResult; onReset:()=>void }) {
  const tilt  = useTilt()
  const color = scoreColor(result.score)
  const rec   = REC[result.recommendation]
  const [copied,setCopied] = useState(false)
  const copySummary = () => { navigator.clipboard.writeText(result.summary); setCopied(true); setTimeout(()=>setCopied(false),2000) }

  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} className="space-y-4">

      {/* Nav row */}
      <div className="flex items-center justify-between mb-2">
        <motion.h2 initial={{x:-16,opacity:0}} animate={{x:0,opacity:1}}
          className="text-xl font-bold text-white truncate">{result.candidate_name}</motion.h2>
        <motion.button initial={{x:16,opacity:0}} animate={{x:0,opacity:1}} onClick={onReset} whileHover={{x:-2}}
          className="ml-4 flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all"
          style={{ background:'rgba(139,92,246,0.1)',color:'rgba(196,181,253,0.7)',border:'1px solid rgba(139,92,246,0.25)' }}
          onMouseEnter={e=>{e.currentTarget.style.color='#c4b5fd';e.currentTarget.style.borderColor='rgba(139,92,246,0.5)'}}
          onMouseLeave={e=>{e.currentTarget.style.color='rgba(196,181,253,0.7)';e.currentTarget.style.borderColor='rgba(139,92,246,0.25)'}}>
          ← New screening
        </motion.button>
      </div>

      {/* Hero score card */}
      <motion.div {...card(0)} ref={tilt.ref} onMouseMove={tilt.move} onMouseLeave={tilt.leave}
        className="tilt-card glass-strong p-8"
        style={{ borderColor:`${color}28`, boxShadow:`0 0 60px ${color}12, 0 0 0 1px ${color}18` }}>
        <div className="flex flex-col sm:flex-row items-center justify-between gap-8">
          {/* Score */}
          <div className="flex flex-col items-center sm:items-start gap-4">
            <BigScore score={result.score}/>
            {/* Progress bar */}
            <div className="w-full sm:w-56">
              <div className="flex justify-between text-[11px] mb-1.5"
                style={{color:'rgba(255,255,255,0.35)'}}>
                <span className="font-bold uppercase tracking-wider">Overall Fit</span>
                <span>{scoreLabel(result.score)}</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.07)'}}>
                <motion.div className="h-full rounded-full"
                  style={{background:`linear-gradient(90deg,${color},${color}cc)`}}
                  initial={{width:0}} animate={{width:`${result.score*10}%`}}
                  transition={{duration:1.6,ease:'easeOut',delay:0.5}}/>
              </div>
            </div>
          </div>
          {/* Recommendation badge */}
          <motion.div initial={{scale:0.6,opacity:0}} animate={{scale:1,opacity:1}}
            transition={{type:'spring',stiffness:140,delay:0.7}}
            className="flex flex-col items-center gap-2">
            <div className="px-10 py-3.5 rounded-2xl font-black text-2xl tracking-[0.2em]"
              style={{background:rec.bg, boxShadow:rec.shadow, color:'white'}}>
              {rec.label}
            </div>
            <p className="text-xs font-semibold uppercase tracking-wider"
              style={{color:'rgba(255,255,255,0.35)'}}>Recommendation</p>
          </motion.div>
        </div>
      </motion.div>

      {/* Strengths & Gaps — left-border cards */}
      <div className="grid grid-cols-2 gap-4">
        {(['strengths','gaps'] as const).map((f,fi)=>(
          <motion.div key={f} {...card(fi+1)} className="glass p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest mb-3"
              style={{color:f==='strengths'?'#34d399':'#f87171'}}>
              {f==='strengths'?'✦ Strengths':'✦ Gaps'}
            </p>
            <div className="space-y-2">
              {result[f].map((item,i)=>(
                <motion.div key={i}
                  initial={{opacity:0,x:f==='strengths'?-8:8}} animate={{opacity:1,x:0}}
                  transition={{delay:0.5+i*0.08}}
                  className="rounded-lg px-3 py-2 text-xs leading-snug"
                  style={{
                    background:f==='strengths'?'rgba(16,185,129,0.07)':'rgba(239,68,68,0.07)',
                    borderLeft:`3px solid ${f==='strengths'?'#10b981':'#ef4444'}`,
                    color:'rgba(255,255,255,0.82)',
                  }}>
                  {item}
                </motion.div>
              ))}
            </div>
          </motion.div>
        ))}
      </div>

      <SkillTags text={result.summary + result.strengths.join(' ')}/>

      {/* AI Summary */}
      <motion.div {...card(4)} className="glass p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-bold uppercase tracking-widest" style={{color:'rgba(255,255,255,0.3)'}}>AI Summary</p>
          <motion.button onClick={copySummary} whileHover={{scale:1.05}} whileTap={{scale:0.95}}
            className="text-xs px-3 py-1 rounded-lg"
            style={{ background:'rgba(139,92,246,0.12)',color:copied?'#34d399':'#c4b5fd',border:'1px solid rgba(139,92,246,0.25)' }}>
            {copied?'✓ Copied':'Copy'}
          </motion.button>
        </div>
        <p className="text-sm leading-relaxed" style={{color:'rgba(255,255,255,0.72)'}}>{result.summary}</p>
      </motion.div>

      {/* GitHub mini card */}
      {result.github_check && (
        <motion.div {...card(5)} className="glass p-5">
          <p className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{color:'rgba(255,255,255,0.3)'}}>
            GitHub Profile
          </p>
          <div className="flex items-start gap-4">
            {/* Status */}
            <div className="flex-shrink-0">
              <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold"
                style={{
                  background: result.github_check.exists?'rgba(16,185,129,0.12)':'rgba(239,68,68,0.12)',
                  color:       result.github_check.exists?'#34d399':'#f87171',
                  border:     `1px solid ${result.github_check.exists?'rgba(16,185,129,0.3)':'rgba(239,68,68,0.3)'}`,
                }}>
                <span className="h-1.5 w-1.5 rounded-full"
                  style={{background:result.github_check.exists?'#34d399':'#f87171'}}/>
                {result.github_check.exists?'Verified':'Not found'}
              </span>
            </div>
            {/* Details */}
            <div className="min-w-0 space-y-2">
              <a href={result.github_check.url} target="_blank" rel="noopener noreferrer"
                className="block text-sm hover:underline truncate" style={{color:'#a78bfa'}}>
                {result.github_check.url}
              </a>
              <div className="flex flex-wrap gap-2 items-center">
                {result.github_check.repo_count != null && (
                  <span className="text-xs px-2.5 py-1 rounded-lg"
                    style={{background:'rgba(139,92,246,0.1)',color:'rgba(196,181,253,0.8)',border:'1px solid rgba(139,92,246,0.2)'}}>
                    {result.github_check.repo_count} repos
                  </span>
                )}
                {result.github_check.top_languages?.map(l=>(
                  <span key={l} className="text-xs px-2.5 py-1 rounded-lg"
                    style={{background:'rgba(6,182,212,0.1)',color:'#67e8f9',border:'1px solid rgba(6,182,212,0.2)'}}>
                    {l}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Actions */}
      <motion.div {...card(7)} className="grid grid-cols-2 gap-3 pt-1">
        <motion.a href={`${API}/report/${encodeURIComponent(result.candidate_name)}`} download
          whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="btn-shimmer-wrap flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white"
          style={{background:'linear-gradient(135deg,#7C3AED,#5B21B6)',boxShadow:'0 0 24px rgba(124,58,237,0.4)'}}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          Download PDF
        </motion.a>
        <motion.button onClick={onReset} whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="rounded-2xl py-3.5 text-sm font-semibold"
          style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.65)'}}>
          Screen Another
        </motion.button>
      </motion.div>
    </motion.div>
  )
}

// ─── Compare results panel (logic unchanged, visuals updated) ─────────────────
function CompareResultsPanel({ response, onReset }: { response: CompareResponse; onReset:()=>void }) {
  const cmp     = response.comparison
  const results = response.individual_results
  const [expanded,  setExpanded]  = useState<number|null>(null)
  const [dlLoading, setDlLoading] = useState(false)

  const scoreMap   = Object.fromEntries(results.map(r => [r.candidate_name.toLowerCase(), r.score]))
  const lookupScore = (name: string) => scoreMap[name.toLowerCase()]
  const sortedRanking = cmp ? [...cmp.ranking].sort((a,b)=>a.rank-b.rank) : []

  const downloadReport = async () => {
    setDlLoading(true)
    try {
      const res = await fetch(`${API}/compare/report`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(response) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `hiring_report_${Date.now()}.pdf`
      document.body.appendChild(a); a.click()
      document.body.removeChild(a); URL.revokeObjectURL(url)
    } catch(err) { console.error('Report download failed:', err) }
    finally { setDlLoading(false) }
  }

  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} className="space-y-5">
      <div className="flex items-center justify-between">
        <motion.h2 initial={{x:-16,opacity:0}} animate={{x:0,opacity:1}} className="text-xl font-bold text-white">
          Comparison Results
        </motion.h2>
        <motion.button initial={{x:16,opacity:0}} animate={{x:0,opacity:1}} onClick={onReset} whileHover={{x:-2}}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg"
          style={{ background:'rgba(139,92,246,0.1)',color:'rgba(196,181,253,0.7)',border:'1px solid rgba(139,92,246,0.25)' }}
          onMouseEnter={e=>{e.currentTarget.style.color='#c4b5fd'}} onMouseLeave={e=>{e.currentTarget.style.color='rgba(196,181,253,0.7)'}}>
          ← New comparison
        </motion.button>
      </div>

      {response.warning && (
        <motion.div {...card(0)} className="rounded-2xl px-4 py-3 text-sm flex items-start gap-2"
          style={{ background:'rgba(245,158,11,0.1)',border:'1px solid rgba(245,158,11,0.25)',color:'#fcd34d' }}>
          <span className="flex-shrink-0 mt-0.5">⚠</span><span>{response.warning}</span>
        </motion.div>
      )}

      {cmp && (
        <motion.div {...card(0)} className="glass-strong p-7"
          style={{ borderColor:'rgba(16,185,129,0.3)', background:'rgba(16,185,129,0.05)', boxShadow:'0 0 60px rgba(16,185,129,0.08)' }}>
          <span className="text-xs font-bold uppercase tracking-widest" style={{color:'#34d399'}}>✓ Recommended Hire</span>
          <h3 className="text-3xl font-black text-white mt-2 mb-4">{cmp.recommended_hire}</h3>
          <p className="text-sm leading-relaxed" style={{color:'rgba(255,255,255,0.68)'}}>{cmp.hiring_memo}</p>
          {cmp.panel_interview_shortlist.length > 0 && (
            <div className="mt-5 pt-4" style={{borderTop:'1px solid rgba(255,255,255,0.07)'}}>
              <p className="text-[11px] font-bold uppercase tracking-widest mb-2.5" style={{color:'rgba(255,255,255,0.3)'}}>Panel Interview Shortlist</p>
              <div className="flex flex-wrap gap-2">
                {cmp.panel_interview_shortlist.map(name=>(
                  <span key={name} className="rounded-full px-3.5 py-1.5 text-xs font-semibold"
                    style={{ background:'rgba(139,92,246,0.15)',color:'#c4b5fd',border:'1px solid rgba(139,92,246,0.3)' }}>
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}

      {cmp && sortedRanking.length > 0 && (
        <motion.div {...card(1)} className="glass overflow-hidden" style={{borderRadius:'16px'}}>
          <div className="grid grid-cols-12 px-4 py-3 text-[11px] font-bold uppercase tracking-widest"
            style={{ background:'rgba(139,92,246,0.18)',color:'#c4b5fd' }}>
            <div className="col-span-1 text-center">#</div>
            <div className="col-span-4">Candidate</div>
            <div className="col-span-2 text-center">Score</div>
            <div className="col-span-4">Verdict</div>
            <div className="col-span-1"/>
          </div>
          {sortedRanking.map((entry,i) => {
            const score=lookupScore(entry.name), isFirst=entry.rank===1
            const isOpen=expanded===entry.rank, hasReason=!!entry.beats_next_because
            return (
              <div key={entry.rank}>
                <button type="button" onClick={()=>setExpanded(isOpen?null:entry.rank)}
                  className="w-full grid grid-cols-12 px-4 py-3.5 text-left transition-colors"
                  style={{
                    background: isFirst?'rgba(16,185,129,0.07)':i%2===0?'rgba(255,255,255,0.02)':'transparent',
                    borderTop: i===0?'none':'1px solid rgba(255,255,255,0.05)',
                    cursor: hasReason?'pointer':'default',
                  }}>
                  <div className="col-span-1 flex items-center justify-center">
                    <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                      style={{ background:isFirst?'rgba(16,185,129,0.25)':'rgba(255,255,255,0.07)', color:isFirst?'#34d399':'rgba(255,255,255,0.5)' }}>
                      {entry.rank}
                    </span>
                  </div>
                  <div className="col-span-4 flex items-center">
                    <span className="text-sm font-semibold" style={{color:isFirst?'#ecfdf5':'rgba(255,255,255,0.85)'}}>
                      {entry.name}
                    </span>
                  </div>
                  <div className="col-span-2 flex items-center justify-center">
                    {score!=null ? (
                      <span className="text-sm font-black" style={{color:scoreColor(score)}}>
                        {score}<span className="text-xs font-normal" style={{color:'rgba(255,255,255,0.3)'}}>/10</span>
                      </span>
                    ) : <span className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>—</span>}
                  </div>
                  <div className="col-span-4 flex items-center">
                    <span className="text-xs leading-snug" style={{color:'rgba(255,255,255,0.55)'}}>{entry.one_line_verdict}</span>
                  </div>
                  <div className="col-span-1 flex items-center justify-end">
                    {hasReason && (
                      <motion.svg animate={{rotate:isOpen?180:0}} transition={{duration:0.2}}
                        className="w-3.5 h-3.5" style={{color:'rgba(255,255,255,0.2)'}}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                      </motion.svg>
                    )}
                  </div>
                </button>
                <AnimatePresence>
                  {isOpen && hasReason && (
                    <motion.div initial={{opacity:0,height:0}} animate={{opacity:1,height:'auto'}} exit={{opacity:0,height:0}}
                      transition={{duration:0.22,ease:'easeOut'}}
                      className="overflow-hidden px-6 py-3 text-sm"
                      style={{ background:'rgba(139,92,246,0.06)', borderTop:'1px solid rgba(139,92,246,0.15)' }}>
                      <span style={{color:'rgba(255,255,255,0.35)'}}>Why #{entry.rank} beats #{entry.rank+1}: </span>
                      <span style={{color:'#c4b5fd'}}>{entry.beats_next_because}</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </motion.div>
      )}

      {cmp && Object.keys(cmp.red_flags).length > 0 && (
        <motion.div {...card(2)} className="space-y-2.5">
          <p className="text-[11px] font-bold uppercase tracking-widest px-1" style={{color:'#fbbf24'}}>⚠ Red Flags</p>
          {Object.entries(cmp.red_flags).map(([name,flag])=>(
            <div key={name} className="rounded-xl px-4 py-3.5"
              style={{ background:'rgba(245,158,11,0.07)', borderLeft:'3px solid #f59e0b', border:'1px solid rgba(245,158,11,0.2)', borderLeftColor:'#f59e0b', borderLeftWidth:'3px' }}>
              <span className="text-sm font-bold" style={{color:'#fbbf24'}}>{name}</span>
              <span className="text-sm" style={{color:'rgba(255,255,255,0.6)'}}>: {flag}</span>
            </div>
          ))}
          <p className="text-xs px-1" style={{color:'rgba(255,255,255,0.2)'}}>
            Red flags are AI-generated. Verify independently before use in hiring decisions.
          </p>
        </motion.div>
      )}

      {!cmp && results.length > 0 && (
        <motion.div {...card(2)} className="glass p-5">
          <p className="text-sm font-semibold text-white mb-3">Individual Scores</p>
          <div className="space-y-2.5">
            {[...results].sort((a,b)=>b.score-a.score).map(r=>(
              <div key={r.candidate_name} className="flex items-center justify-between">
                <span className="text-sm" style={{color:'rgba(255,255,255,0.7)'}}>{r.candidate_name}</span>
                <span className="text-sm font-black" style={{color:scoreColor(r.score)}}>{r.score}/10</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      <motion.div {...card(3)} className="grid grid-cols-2 gap-3 pt-1">
        <motion.button onClick={downloadReport} disabled={dlLoading||!cmp}
          whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="btn-shimmer-wrap flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
          style={{background:'linear-gradient(135deg,#065f46,#059669)',boxShadow:'0 0 24px rgba(16,185,129,0.3)'}}>
          {dlLoading ? (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
          )}
          Download Hiring Report PDF
        </motion.button>
        <motion.button onClick={onReset} whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="rounded-2xl py-3.5 text-sm font-semibold"
          style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',color:'rgba(255,255,255,0.65)'}}>
          Compare Again
        </motion.button>
      </motion.div>
    </motion.div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Page() {
  // ── State (all logic unchanged) ──────────────────────────────────────────
  const [tab,     setTab]    = useState<Tab>('single')
  const [jobDesc, setJobDesc]= useState('')
  const formTilt = useTilt()
  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null)
  const [phase,   setPhase]  = useState<Phase>('idle')
  const [file,    setFile]   = useState<File|null>(null)
  const [result,  setResult] = useState<ScreeningResult|null>(null)
  const [error,   setError]  = useState<string|null>(null)
  const [stepIdx, setStepIdx]= useState(0)
  const [cPhase,         setCPhase]         = useState<Phase>('idle')
  const [cFiles,         setCFiles]         = useState<File[]>([])
  const [compareResult,  setCompareResult]  = useState<CompareResponse|null>(null)
  const [cError,         setCError]         = useState<string|null>(null)
  const [cStepIdx,       setCStepIdx]       = useState(0)

  const isLoading = (tab==='single'&&phase==='loading') || (tab==='compare'&&cPhase==='loading')
  useEffect(()=>{
    if (isLoading) {
      const steps=tab==='single'?STEPS:COMPARE_STEPS, setIdx=tab==='single'?setStepIdx:setCStepIdx
      setIdx(0)
      timerRef.current=setInterval(()=>setIdx(i=>Math.min(i+1,steps.length-1)),1700)
    } else { if(timerRef.current) clearInterval(timerRef.current) }
    return ()=>{ if(timerRef.current) clearInterval(timerRef.current) }
  },[isLoading,tab])

  const submitSingle = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); if(!file||!jobDesc.trim()) return
    setPhase('loading'); setError(null)
    try {
      const body=new FormData(); body.append('pdf_file',file); body.append('job_description',jobDesc.trim())
      const res=await fetch(`${API}/screen`,{method:'POST',body})
      if(!res.ok){const p=await res.json().catch(()=>({detail:res.statusText}));throw new Error(p?.detail??`HTTP ${res.status}`)}
      setResult(await res.json()); setPhase('result')
    } catch(err){setError(err instanceof Error?err.message:'Unexpected error.'); setPhase('error')}
  }

  const submitCompare = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); if(cFiles.length<2||!jobDesc.trim()) return
    setCPhase('loading'); setCError(null)
    try {
      const body=new FormData(); body.append('job_description',jobDesc.trim())
      cFiles.forEach(f=>body.append('pdf_files',f))
      const res=await fetch(`${API}/compare`,{method:'POST',body})
      if(!res.ok){const p=await res.json().catch(()=>({detail:res.statusText}));throw new Error(p?.detail??`HTTP ${res.status}`)}
      setCompareResult(await res.json()); setCPhase('result')
    } catch(err){setCError(err instanceof Error?err.message:'Unexpected error.'); setCPhase('error')}
  }

  const resetSingle  = ()=>{setPhase('idle');setResult(null);setError(null);setFile(null)}
  const resetCompare = ()=>{setCPhase('idle');setCompareResult(null);setCError(null);setCFiles([])}

  const showSingleResult  = tab==='single'  && phase==='result'  && !!result
  const showCompareResult = tab==='compare' && cPhase==='result' && !!compareResult
  const showLoading       = isLoading
  const showForm          = !showSingleResult && !showCompareResult && !showLoading
  const activeSteps = tab==='single'?STEPS:COMPARE_STEPS
  const activeIdx   = tab==='single'?stepIdx:cStepIdx

  // ── Shared textarea style ────────────────────────────────────────────────
  const textareaStyle = {
    background:'#0D0D1A', border:'1px solid rgba(139,92,246,0.2)',
    color:'#f1f5f9', caretColor:'#8B5CF6', borderRadius:'12px',
  }
  const textareaFocus = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    e.target.style.borderColor='rgba(139,92,246,0.6)'
    e.target.style.boxShadow='0 0 0 3px rgba(139,92,246,0.12), 0 0 16px rgba(139,92,246,0.08)'
  }
  const textareaBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    e.target.style.borderColor='rgba(139,92,246,0.2)'; e.target.style.boxShadow='none'
  }

  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(160deg,#0F0F1A 0%,#1A0F2E 100%)' }}>
      <Background/>
      <div className="relative z-10 min-h-screen flex flex-col">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <motion.header initial={{y:-24,opacity:0}} animate={{y:0,opacity:1}}
          className="sticky top-0 z-20"
          style={{background:'rgba(15,10,30,0.8)',backdropFilter:'blur(24px)',borderBottom:'1px solid rgba(139,92,246,0.12)'}}>
          <div className="mx-auto max-w-2xl px-4 py-3.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <motion.div animate={{rotateY:[0,360]}} transition={{duration:9,repeat:Infinity,ease:'linear'}}
                className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{background:'linear-gradient(135deg,#8B5CF6,#5B21B6)',boxShadow:'0 0 20px rgba(139,92,246,0.5)',transformStyle:'preserve-3d'}}>
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                </svg>
              </motion.div>
              <div>
                <p className="text-sm font-black leading-none gradient-text-hero">AI Resume Screener</p>
                <p className="text-[10px] mt-0.5" style={{color:'rgba(196,181,253,0.45)'}}>Groq · LLaMA-3.3-70b</p>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-1.5">
              <motion.div className="w-1.5 h-1.5 rounded-full" style={{background:'#10b981'}}
                animate={{scale:[1,1.6,1],opacity:[1,0.4,1]}} transition={{duration:2,repeat:Infinity}}/>
              <span className="text-xs font-semibold" style={{color:'#6ee7b7'}}>Live</span>
            </div>
          </div>
        </motion.header>

        <main className="flex-1 mx-auto w-full max-w-2xl px-4 pb-4">
          <AnimatePresence mode="wait">

            {/* Single result */}
            {showSingleResult && (
              <motion.div key="single-result" initial={{opacity:0,y:16}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}} className="pt-8">
                <ResultsPanel result={result!} onReset={resetSingle}/>
              </motion.div>
            )}

            {/* Compare result */}
            {showCompareResult && (
              <motion.div key="compare-result" initial={{opacity:0,y:16}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}} className="pt-8">
                <CompareResultsPanel response={compareResult!} onReset={resetCompare}/>
              </motion.div>
            )}

            {/* Loading */}
            {showLoading && (
              <motion.div key="loading" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
                className="glass mt-12" style={{borderRadius:'24px'}}>
                <AtomLoader status={activeSteps[activeIdx]}/>
              </motion.div>
            )}

            {/* Form */}
            {showForm && (
              <motion.div key="form" initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-12}}
                transition={{duration:0.45,ease:'easeOut'}}>

                {/* ── Hero ─────────────────────────────────────────────── */}
                <div className="pt-12 pb-6 text-center">
                  {/* Top badge */}
                  <motion.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={{delay:0.05}}
                    className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 mb-6 text-xs font-semibold"
                    style={{background:'rgba(139,92,246,0.12)',color:'#c4b5fd',border:'1px solid rgba(139,92,246,0.28)'}}>
                    ✦ Powered by Groq · sub-second inference
                  </motion.div>

                  {/* Main heading */}
                  <motion.h1 initial={{opacity:0,y:16}} animate={{opacity:1,y:0}} transition={{delay:0.1}}
                    className="font-black leading-tight mb-0"
                    style={{fontSize:'clamp(2.6rem,6.5vw,4rem)'}}>
                    <span className="block text-white">Screen Smarter.</span>
                    <span className="block gradient-text-hero">Hire Better.</span>
                  </motion.h1>

                  {/* Subtitle */}
                  <motion.p initial={{opacity:0}} animate={{opacity:1}} transition={{delay:0.2}}
                    className="text-sm max-w-sm mx-auto leading-relaxed mt-4"
                    style={{color:'rgba(255,255,255,0.45)'}}>
                    AI-powered résumé screening with GitHub verification, multi-candidate comparison, and PDF reports.
                  </motion.p>

                  {/* Animated counters */}
                  <CounterStats/>

                  {/* Feature badges */}
                  <motion.div initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{delay:0.35}}
                    className="flex flex-wrap justify-center gap-2.5 mt-7">
                    {FEATURES.map(f=>(
                      <FeatureBadge key={f.label} icon={f.icon} label={f.label} color={f.color}/>
                    ))}
                  </motion.div>
                </div>

                {/* ── Tab switcher ──────────────────────────────────────── */}
                <motion.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={{delay:0.4}}
                  className="flex rounded-xl p-1 mb-5"
                  style={{background:'rgba(139,92,246,0.08)',border:'1px solid rgba(139,92,246,0.18)'}}>
                  {([
                    { key:'single',  icon:'📄', label:'Screen Candidate'   },
                    { key:'compare', icon:'⚖️', label:'Compare Candidates' },
                  ] as const).map(t=>(
                    <button key={t.key} onClick={()=>setTab(t.key)}
                      className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all"
                      style={{
                        background:   tab===t.key ? '#7C3AED' : 'transparent',
                        color:        tab===t.key ? '#fff'    : 'rgba(255,255,255,0.4)',
                        boxShadow:    tab===t.key ? '0 0 16px rgba(124,58,237,0.4)' : 'none',
                        border:       tab===t.key ? '1px solid rgba(139,92,246,0.5)' : '1px solid transparent',
                      }}>
                      {t.icon} {t.label}
                    </button>
                  ))}
                </motion.div>

                {/* ── Single tab form ───────────────────────────────────── */}
                {tab==='single' && (
                  <form onSubmit={submitSingle} className="space-y-4">
                    <motion.div ref={formTilt.ref} onMouseMove={formTilt.move} onMouseLeave={formTilt.leave}
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.44}}
                      className="glass tilt-card p-6">
                      <label className="block text-xs font-bold uppercase tracking-widest mb-3"
                        style={{color:'rgba(196,181,253,0.5)'}}>Job Description</label>
                      <textarea value={jobDesc} onChange={e=>setJobDesc(e.target.value)}
                        rows={6} placeholder="Paste the full job description here…" required minLength={10}
                        className="w-full resize-none px-4 py-3 text-sm outline-none"
                        style={textareaStyle}
                        onFocus={textareaFocus} onBlur={textareaBlur}
                      />
                    </motion.div>

                    <motion.div className="glass p-6"
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.5}}>
                      <label className="block text-xs font-bold uppercase tracking-widest mb-3"
                        style={{color:'rgba(196,181,253,0.5)'}}>Résumé File</label>
                      <FileDropzone file={file} onFile={setFile}/>
                    </motion.div>

                    <AnimatePresence>
                      {phase==='error'&&error&&(
                        <motion.div initial={{opacity:0,y:-6,scale:0.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0}}
                          className="flex items-start gap-3 rounded-2xl px-4 py-3.5 text-sm"
                          style={{background:'rgba(239,68,68,0.09)',border:'1px solid rgba(239,68,68,0.25)',color:'#fca5a5'}}>
                          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 20 20" fill="#f87171">
                            <path fillRule="evenodd" clipRule="evenodd" d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"/>
                          </svg>
                          {error}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <motion.button type="submit" disabled={!file||!jobDesc.trim()}
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.56}}
                      whileHover={{scale:1.01,y:-1,boxShadow:'0 0 28px rgba(139,92,246,0.55)'}}
                      whileTap={{scale:0.98}}
                      className="btn-shimmer-wrap w-full flex items-center justify-center gap-2.5 rounded-2xl py-4 text-sm font-bold text-white disabled:opacity-35 disabled:cursor-not-allowed"
                      style={{ background:'linear-gradient(135deg,#8B5CF6,#7C3AED,#6D28D9)', boxShadow:'0 0 20px rgba(139,92,246,0.35)' }}>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/>
                      </svg>
                      Screen Candidate
                    </motion.button>
                  </form>
                )}

                {/* ── Compare tab form ──────────────────────────────────── */}
                {tab==='compare' && (
                  <form onSubmit={submitCompare} className="space-y-4">
                    <motion.div ref={formTilt.ref} onMouseMove={formTilt.move} onMouseLeave={formTilt.leave}
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.44}}
                      className="glass tilt-card p-6">
                      <label className="block text-xs font-bold uppercase tracking-widest mb-3"
                        style={{color:'rgba(196,181,253,0.5)'}}>Job Description</label>
                      <textarea value={jobDesc} onChange={e=>setJobDesc(e.target.value)}
                        rows={4} placeholder="Paste the full job description here…" required minLength={10}
                        className="w-full resize-none px-4 py-3 text-sm outline-none"
                        style={textareaStyle} onFocus={textareaFocus} onBlur={textareaBlur}
                      />
                    </motion.div>

                    <motion.div className="glass p-6"
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.5}}>
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-xs font-bold uppercase tracking-widest"
                          style={{color:'rgba(196,181,253,0.5)'}}>Résumé PDFs</label>
                        <span className="text-xs font-bold px-2.5 py-1 rounded-full"
                          style={{ background:cFiles.length>=2?'rgba(16,185,129,0.14)':'rgba(139,92,246,0.1)',
                            color:cFiles.length>=2?'#34d399':'rgba(196,181,253,0.5)',
                            border:`1px solid ${cFiles.length>=2?'rgba(16,185,129,0.3)':'rgba(139,92,246,0.2)'}` }}>
                          {cFiles.length} / 10
                        </span>
                      </div>
                      <MultiFileDropzone files={cFiles} onFiles={setCFiles}/>
                    </motion.div>

                    <AnimatePresence>
                      {cPhase==='error'&&cError&&(
                        <motion.div initial={{opacity:0,y:-6,scale:0.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0}}
                          className="flex items-start gap-3 rounded-2xl px-4 py-3.5 text-sm"
                          style={{background:'rgba(239,68,68,0.09)',border:'1px solid rgba(239,68,68,0.25)',color:'#fca5a5'}}>
                          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 20 20" fill="#f87171">
                            <path fillRule="evenodd" clipRule="evenodd" d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"/>
                          </svg>
                          {cError}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <motion.button type="submit" disabled={cFiles.length<2||!jobDesc.trim()}
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.56}}
                      whileHover={{scale:1.01,y:-1,boxShadow:'0 0 28px rgba(6,182,212,0.4)'}}
                      whileTap={{scale:0.98}}
                      className="btn-shimmer-wrap w-full flex items-center justify-center gap-2.5 rounded-2xl py-4 text-sm font-bold text-white disabled:opacity-35 disabled:cursor-not-allowed"
                      style={{ background:'linear-gradient(135deg,#0891b2,#0e7490,#164e63)', boxShadow:'0 0 20px rgba(6,182,212,0.25)' }}>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                      </svg>
                      Compare {cFiles.length>=2?`${cFiles.length} Candidates`:'Candidates'}
                    </motion.button>
                  </form>
                )}

                <motion.p initial={{opacity:0}} animate={{opacity:1}} transition={{delay:0.65}}
                  className="text-center text-xs mt-5" style={{color:'rgba(255,255,255,0.18)'}}>
                  {tab==='single'
                    ? 'LLaMA-3.3-70b on Groq · GitHub data via public API'
                    : 'Two LLM passes: individual scoring + comparative analysis'}
                </motion.p>
              </motion.div>
            )}

          </AnimatePresence>
        </main>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <footer className="relative z-10 py-5 px-4 mt-auto"
          style={{ borderTop:'1px solid rgba(139,92,246,0.1)' }}>
          <div className="mx-auto max-w-2xl flex items-center justify-center gap-3">
            <span className="text-xs" style={{color:'rgba(255,255,255,0.22)'}}>
              Built with Next.js · FastAPI · Groq · LLaMA-3.3-70b
            </span>
            <a href="https://github.com/Maryam-1017/AI-Resume-Screener"
              target="_blank" rel="noopener noreferrer"
              className="transition-colors"
              style={{color:'rgba(255,255,255,0.22)'}}
              onMouseEnter={e=>(e.currentTarget.style.color='#c4b5fd')}
              onMouseLeave={e=>(e.currentTarget.style.color='rgba(255,255,255,0.22)')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234C5.662 21.299 4.967 19.16 4.967 19.16c-.547-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 6.998c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
              </svg>
            </a>
          </div>
        </footer>

      </div>
    </div>
  )
}
