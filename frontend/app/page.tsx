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
type CandidateRanking = {
  rank: number; name: string
  one_line_verdict: string; beats_next_because?: string | null
}
type ComparisonResult = {
  recommended_hire: string
  ranking: CandidateRanking[]
  panel_interview_shortlist: string[]
  red_flags: Record<string, string>
  hiring_memo: string
  job_description_summary: string
  total_candidates: number
}
type CompareResponse = {
  individual_results: ScreeningResult[]
  comparison: ComparisonResult | null
  screened_at: string
  warning?: string
}
type Phase = 'idle' | 'loading' | 'result' | 'error'
type Tab   = 'single' | 'compare'

// ─── Constants ───────────────────────────────────────────────────────────────
const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')

const STEPS         = ['Parsing résumé…','Analyzing candidate fit…','Verifying GitHub…','Generating report…']
const COMPARE_STEPS = ['Parsing résumés…','Scoring candidates…','Running comparison analysis…','Building report…']

const REC = {
  hire:  { label:'HIRE',  bg:'linear-gradient(135deg,#059669,#10b981)', shadow:'#10b98155' },
  maybe: { label:'MAYBE', bg:'linear-gradient(135deg,#b45309,#f59e0b)', shadow:'#f59e0b55' },
  pass:  { label:'PASS',  bg:'linear-gradient(135deg,#b91c1c,#ef4444)', shadow:'#ef444455' },
}

const scoreColor = (s: number) => s >= 8 ? '#10b981' : s >= 5 ? '#f59e0b' : '#ef4444'
const scoreLabel = (s: number) => s >= 8 ? '🟢 Strong' : s >= 5 ? '🟡 Partial' : '🔴 Weak'

const ORBS = [
  { x:'5%',  y:'10%', s:600, c:'#4f46e5', o:0.22, d:10 },
  { x:'70%', y:'3%',  s:450, c:'#7c3aed', o:0.18, d:14 },
  { x:'85%', y:'55%', s:500, c:'#1d4ed8', o:0.15, d:11 },
  { x:'10%', y:'65%', s:400, c:'#0891b2', o:0.14, d:16 },
  { x:'45%', y:'38%', s:350, c:'#6d28d9', o:0.10, d:9  },
]

const FEATURES = [
  { icon:'⚡', label:'Groq LLaMA-3.3' },
  { icon:'📄', label:'PDF & Word' },
  { icon:'🐙', label:'GitHub Verified' },
  { icon:'📊', label:'Score 1–10' },
  { icon:'⚖️', label:'Candidate Compare' },
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
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0" style={{ background:'#06060f' }}>
      {ORBS.map((o,i) => (
        <motion.div key={i} className="absolute rounded-full"
          style={{ left:o.x, top:o.y, width:o.s, height:o.s, background:o.c, opacity:o.o, filter:'blur(100px)' }}
          animate={{ x:[0,30,-20,10,0], y:[0,-25,15,-8,0], scale:[1,1.15,0.92,1.08,1] }}
          transition={{ duration:o.d, repeat:Infinity, ease:'easeInOut' }}
        />
      ))}
      <div className="absolute inset-0 opacity-[0.04]" style={{
        backgroundImage:'linear-gradient(rgba(255,255,255,.6) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.6) 1px,transparent 1px)',
        backgroundSize:'64px 64px',
      }}/>
    </div>
  )
}

// ─── Atom loader ──────────────────────────────────────────────────────────────
function AtomLoader({ status }: { status: string }) {
  return (
    <div className="flex flex-col items-center gap-8 py-20">
      <div className="relative w-28 h-28" style={{ perspective:500 }}>
        <motion.div className="absolute rounded-full"
          style={{ width:14,height:14,top:'50%',left:'50%',marginTop:-7,marginLeft:-7,
            background:'radial-gradient(circle,#c4b5fd,#818cf8)',boxShadow:'0 0 20px #818cf8' }}
          animate={{ scale:[1,1.5,1],opacity:[0.8,1,0.8] }} transition={{ duration:1.5,repeat:Infinity }}
        />
        {[{rx:0,ry:0,c:'#818cf8',d:1.4},{rx:60,ry:60,c:'#a78bfa',d:2},{rx:-60,ry:30,c:'#22d3ee',d:2.6}].map((r,i)=>(
          <motion.div key={i} className="absolute inset-0 rounded-full"
            style={{ border:`2px solid ${r.c}60`, rotateX:r.rx, rotateY:r.ry }}
            animate={{ rotateZ:360 }} transition={{ duration:r.d, repeat:Infinity, ease:'linear' }}
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
              animate={{ opacity:[0.2,1,0.2],y:[0,-5,0] }}
              transition={{ duration:1.1,repeat:Infinity,delay:i*0.18 }}
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
          transition={{ duration:1.8,ease:'easeOut',delay:0.3 }}
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

// ─── SkillTags ────────────────────────────────────────────────────────────────
function SkillTags({ text }: { text: string }) {
  const TECH = ['python','javascript','typescript','react','next','node','fastapi','django','docker','kubernetes',
    'aws','gcp','azure','sql','postgresql','mongodb','redis','git','machine learning','pytorch','tensorflow',
    'llm','openai','langchain','java','c++','rust','go','vue','angular','flutter']
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
            style={{ background:'rgba(99,102,241,0.15)',color:'#a5b4fc',border:'1px solid rgba(99,102,241,0.25)' }}>
            {s}
          </motion.span>
        ))}
      </div>
    </motion.div>
  )
}

// ─── Card animation helper ────────────────────────────────────────────────────
const card = (i: number) => ({
  initial:   { opacity:0, y:28, scale:0.97 },
  animate:   { opacity:1, y:0,  scale:1    },
  transition:{ delay:i*0.11, duration:0.45, ease:'easeOut' as const },
})

// ─── Single-file dropzone ─────────────────────────────────────────────────────
function FileDropzone({ file, onFile }: { file: File|null; onFile:(f:File)=>void }) {
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
              style={{ background:'rgba(16,185,129,0.18)',border:'1.5px solid #10b98155' }}>
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
              style={{ background:'rgba(99,102,241,0.14)',border:'1.5px solid rgba(99,102,241,0.35)' }}>
              <svg className="w-6 h-6" style={{color:'#818cf8'}} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </motion.div>
            <p className="text-sm font-medium" style={{color:'rgba(255,255,255,0.75)'}}>
              {isDragActive?'Drop it here…':'Drag & drop, or click to browse'}
            </p>
            <p className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>PDF or Word (.docx) · max 10 MB</p>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Multi-file dropzone ──────────────────────────────────────────────────────
function MultiFileDropzone({ files, onFiles }: { files: File[]; onFiles:(f:File[])=>void }) {
  const onDrop = useCallback((accepted: File[]) => {
    const merged = [...files, ...accepted]
    const unique = Array.from(new Map(merged.map(f => [f.name, f])).values())
    onFiles(unique.slice(0, 10))
  }, [files, onFiles])

  const { getRootProps,getInputProps,isDragActive } = useDropzone({
    onDrop, multiple:true, maxFiles:10,
    accept:{ 'application/pdf':['.pdf'] },
  })

  const remove = (name: string) => onFiles(files.filter(f => f.name !== name))

  const atMin = files.length >= 2
  const atMax = files.length >= 10

  return (
    <div>
      <div {...getRootProps()} className="rounded-2xl cursor-pointer relative overflow-hidden" style={{
        background: isDragActive?'rgba(99,102,241,0.12)':atMin?'rgba(16,185,129,0.05)':'rgba(255,255,255,0.04)',
        border:`1.5px dashed ${isDragActive?'#818cf8':atMin?'rgba(16,185,129,0.5)':'rgba(255,255,255,0.18)'}`,
        transition:'all 0.25s ease',
      }}>
        <input {...getInputProps()}/>
        {isDragActive&&(
          <motion.div className="absolute inset-0 rounded-2xl pointer-events-none"
            style={{ boxShadow:'inset 0 0 40px rgba(99,102,241,0.2)' }}
            animate={{ opacity:[0.4,1,0.4] }} transition={{ duration:0.9,repeat:Infinity }}/>
        )}
        <div className="flex flex-col items-center gap-3 py-8 px-6 text-center">
          <motion.div animate={{ y:[0,-5,0] }} transition={{ duration:2.5,repeat:Infinity,ease:'easeInOut' }}
            className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background:'rgba(99,102,241,0.14)',border:'1.5px solid rgba(99,102,241,0.35)' }}>
            <svg className="w-5 h-5" style={{color:'#818cf8'}} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
            </svg>
          </motion.div>
          <div>
            <p className="text-sm font-medium" style={{color:'rgba(255,255,255,0.75)'}}>
              {isDragActive ? 'Drop PDFs here…'
                : atMax ? '10 files maximum reached'
                : `${isDragActive?'Drop':'Drag & drop'} PDFs here, or click to select`}
            </p>
            <p className="text-xs mt-1" style={{color:'rgba(255,255,255,0.3)'}}>
              {files.length} / 10 files · need at least 2 to compare
            </p>
          </div>
        </div>
      </div>

      {/* File chips */}
      <AnimatePresence>
        {files.length > 0 && (
          <motion.div initial={{opacity:0,height:0}} animate={{opacity:1,height:'auto'}} exit={{opacity:0,height:0}}
            className="flex flex-wrap gap-2 mt-3 overflow-hidden">
            {files.map((f,i)=>(
              <motion.div key={f.name}
                initial={{opacity:0,scale:0.85,x:-8}} animate={{opacity:1,scale:1,x:0}}
                exit={{opacity:0,scale:0.85,x:8}} transition={{delay:i*0.04}}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium max-w-[200px]"
                style={{ background:'rgba(99,102,241,0.15)',color:'#a5b4fc',border:'1px solid rgba(99,102,241,0.25)' }}>
                <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <span className="truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={e=>{ e.stopPropagation(); remove(f.name) }}
                  className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center transition-colors"
                  style={{ color:'rgba(165,180,252,0.6)' }}
                  onMouseEnter={e=>(e.currentTarget.style.color='#f87171')}
                  onMouseLeave={e=>(e.currentTarget.style.color='rgba(165,180,252,0.6)')}>
                  ×
                </button>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Single screening results panel ──────────────────────────────────────────
function ResultsPanel({ result, onReset }: { result: ScreeningResult; onReset:()=>void }) {
  const tilt  = useTilt()
  const color = scoreColor(result.score)
  const rec   = REC[result.recommendation]
  const [copied,setCopied] = useState(false)
  const copySummary = () => { navigator.clipboard.writeText(result.summary); setCopied(true); setTimeout(()=>setCopied(false),2000) }

  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} className="space-y-4">
      <div className="flex items-center justify-between mb-1">
        <motion.h2 initial={{x:-16,opacity:0}} animate={{x:0,opacity:1}} className="text-xl font-bold text-white truncate">
          {result.candidate_name}
        </motion.h2>
        <motion.button initial={{x:16,opacity:0}} animate={{x:0,opacity:1}} onClick={onReset} whileHover={{x:-2}}
          className="ml-4 flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg"
          style={{ background:'rgba(255,255,255,0.07)',color:'rgba(255,255,255,0.5)',border:'1px solid rgba(255,255,255,0.1)' }}
          onMouseEnter={e=>{e.currentTarget.style.color='#818cf8'}} onMouseLeave={e=>{e.currentTarget.style.color='rgba(255,255,255,0.5)'}}>
          ← New screening
        </motion.button>
      </div>

      <motion.div {...card(0)} ref={tilt.ref} onMouseMove={tilt.move} onMouseLeave={tilt.leave}
        className="tilt-card glass-strong rounded-3xl p-7"
        style={{ border:`1px solid ${color}30`,boxShadow:`0 0 60px ${color}12` }}>
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-6">
            <ScoreRing score={result.score}/>
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-widest" style={{color:'rgba(255,255,255,0.35)'}}>Overall Fit</p>
              <div className="w-48 h-2 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.08)'}}>
                <motion.div className="h-full rounded-full" style={{background:`linear-gradient(90deg,${color},${color}aa)`}}
                  initial={{width:0}} animate={{width:`${result.score*10}%`}} transition={{duration:1.6,ease:'easeOut',delay:0.4}}/>
              </div>
              <p className="text-xs" style={{color:'rgba(255,255,255,0.4)'}}>
                {scoreLabel(result.score)} experience match
              </p>
            </div>
          </div>
          <motion.div initial={{rotateY:-90,opacity:0}} animate={{rotateY:0,opacity:1}}
            transition={{type:'spring',stiffness:100,delay:0.8}} className="flex flex-col items-center gap-2" style={{transformStyle:'preserve-3d'}}>
            <div className="px-9 py-3 rounded-2xl font-black text-xl tracking-[0.18em]"
              style={{background:rec.bg,boxShadow:`0 0 40px ${rec.shadow},0 4px 20px ${rec.shadow}`,color:'white'}}>
              {rec.label}
            </div>
            <p className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>Recommendation</p>
          </motion.div>
        </div>
      </motion.div>

      <div className="grid grid-cols-2 gap-4">
        {(['strengths','gaps'] as const).map((f,fi)=>(
          <motion.div key={f} {...card(fi+1)} className="glass rounded-2xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest mb-3"
              style={{color:f==='strengths'?'#34d399':'#f87171'}}>
              {f==='strengths'?'✦ Strengths':'✦ Gaps'}
            </p>
            <ul className="space-y-2.5">
              {result[f].map((item,i)=>(
                <motion.li key={i} initial={{opacity:0,x:f==='strengths'?-10:10}} animate={{opacity:1,x:0}}
                  transition={{delay:0.55+i*0.1}} className="flex items-start gap-2 text-sm leading-snug"
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

      <SkillTags text={result.summary + result.strengths.join(' ')}/>

      <motion.div {...card(4)} className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-bold uppercase tracking-widest" style={{color:'rgba(255,255,255,0.35)'}}>AI Summary</p>
          <motion.button onClick={copySummary} whileHover={{scale:1.05}} whileTap={{scale:0.95}}
            className="text-xs px-3 py-1 rounded-lg" style={{ background:'rgba(99,102,241,0.15)',color:copied?'#34d399':'#a5b4fc',border:'1px solid rgba(99,102,241,0.25)' }}>
            {copied?'✓ Copied':'Copy'}
          </motion.button>
        </div>
        <p className="text-sm leading-relaxed" style={{color:'rgba(255,255,255,0.75)'}}>{result.summary}</p>
      </motion.div>

      {result.github_check&&(
        <motion.div {...card(5)} className="glass rounded-2xl p-5">
          <p className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{color:'rgba(255,255,255,0.35)'}}>GitHub Profile</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
              style={{ background:result.github_check.exists?'rgba(16,185,129,0.14)':'rgba(239,68,68,0.14)',
                color:result.github_check.exists?'#34d399':'#f87171',
                border:`1px solid ${result.github_check.exists?'#34d39930':'#f8717130'}` }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{background:result.github_check.exists?'#34d399':'#f87171'}}/>
              {result.github_check.exists?'Verified':'Not found'}
            </span>
            <a href={result.github_check.url} target="_blank" rel="noopener noreferrer"
              className="text-sm hover:underline truncate max-w-[14rem]" style={{color:'#818cf8'}}>
              {result.github_check.url}
            </a>
            {result.github_check.repo_count!=null&&(
              <span className="text-xs px-2.5 py-1 rounded-lg" style={{background:'rgba(255,255,255,0.06)',color:'rgba(255,255,255,0.5)'}}>
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

      <motion.div {...card(7)} className="grid grid-cols-2 gap-3 pt-1">
        <motion.a href={`${API}/report/${encodeURIComponent(result.candidate_name)}`} download
          whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white"
          style={{background:'linear-gradient(135deg,#4338ca,#6d28d9,#0891b2)',boxShadow:'0 0 40px rgba(99,102,241,0.35)'}}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          Download PDF
        </motion.a>
        <motion.button onClick={onReset} whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="rounded-2xl py-3.5 text-sm font-semibold"
          style={{background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.12)',color:'rgba(255,255,255,0.7)'}}>
          Screen Another
        </motion.button>
      </motion.div>
    </motion.div>
  )
}

// ─── Compare results panel ────────────────────────────────────────────────────
function CompareResultsPanel({ response, onReset }: { response: CompareResponse; onReset:()=>void }) {
  const cmp     = response.comparison
  const results = response.individual_results
  const [expanded, setExpanded]   = useState<number|null>(null)
  const [dlLoading, setDlLoading] = useState(false)

  // Build score lookup from individual results
  const scoreMap = Object.fromEntries(results.map(r => [r.candidate_name.toLowerCase(), r.score]))
  const lookupScore = (name: string) => scoreMap[name.toLowerCase()]

  const sortedRanking = cmp ? [...cmp.ranking].sort((a,b)=>a.rank-b.rank) : []

  const downloadReport = async () => {
    setDlLoading(true)
    try {
      const res = await fetch(`${API}/compare/report`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(response),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url
      a.download = `hiring_report_${Date.now()}.pdf`
      document.body.appendChild(a); a.click()
      document.body.removeChild(a); URL.revokeObjectURL(url)
    } catch(err) {
      console.error('Report download failed:', err)
    } finally {
      setDlLoading(false)
    }
  }

  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} className="space-y-5">

      {/* Nav */}
      <div className="flex items-center justify-between">
        <motion.h2 initial={{x:-16,opacity:0}} animate={{x:0,opacity:1}}
          className="text-xl font-bold text-white">
          Comparison Results
        </motion.h2>
        <motion.button initial={{x:16,opacity:0}} animate={{x:0,opacity:1}} onClick={onReset} whileHover={{x:-2}}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg"
          style={{ background:'rgba(255,255,255,0.07)',color:'rgba(255,255,255,0.5)',border:'1px solid rgba(255,255,255,0.1)' }}
          onMouseEnter={e=>{e.currentTarget.style.color='#818cf8'}} onMouseLeave={e=>{e.currentTarget.style.color='rgba(255,255,255,0.5)'}}>
          ← New comparison
        </motion.button>
      </div>

      {/* Warning if comparison failed */}
      {response.warning && (
        <motion.div {...card(0)} className="rounded-2xl px-4 py-3 text-sm flex items-start gap-2"
          style={{ background:'rgba(245,158,11,0.1)',border:'1px solid rgba(245,158,11,0.25)',color:'#fcd34d' }}>
          <span className="flex-shrink-0 mt-0.5">⚠</span>
          <span>{response.warning}</span>
        </motion.div>
      )}

      {/* Winner card */}
      {cmp && (
        <motion.div {...card(0)} className="glass-strong rounded-3xl p-7"
          style={{ border:'1px solid rgba(16,185,129,0.35)',background:'rgba(16,185,129,0.06)',boxShadow:'0 0 60px rgba(16,185,129,0.1)' }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-bold uppercase tracking-widest" style={{color:'#34d399'}}>
              ✓ Recommended Hire
            </span>
          </div>
          <h3 className="text-3xl font-black text-white mb-4">{cmp.recommended_hire}</h3>
          <p className="text-sm leading-relaxed" style={{color:'rgba(255,255,255,0.7)'}}>{cmp.hiring_memo}</p>

          {/* Shortlist badges */}
          {cmp.panel_interview_shortlist.length > 0 && (
            <div className="mt-5 pt-4" style={{borderTop:'1px solid rgba(255,255,255,0.08)'}}>
              <p className="text-[11px] font-bold uppercase tracking-widest mb-2.5" style={{color:'rgba(255,255,255,0.35)'}}>
                Panel Interview Shortlist
              </p>
              <div className="flex flex-wrap gap-2">
                {cmp.panel_interview_shortlist.map(name=>(
                  <span key={name} className="rounded-full px-3.5 py-1.5 text-xs font-semibold"
                    style={{ background:'rgba(99,102,241,0.18)',color:'#a5b4fc',border:'1px solid rgba(99,102,241,0.35)' }}>
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* Ranking table */}
      {cmp && sortedRanking.length > 0 && (
        <motion.div {...card(1)} className="glass rounded-2xl overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-12 px-4 py-3 text-[11px] font-bold uppercase tracking-widest"
            style={{ background:'rgba(99,102,241,0.2)',color:'#a5b4fc' }}>
            <div className="col-span-1 text-center">#</div>
            <div className="col-span-4">Candidate</div>
            <div className="col-span-2 text-center">Score</div>
            <div className="col-span-4">Verdict</div>
            <div className="col-span-1"/>
          </div>

          {sortedRanking.map((entry,i) => {
            const score   = lookupScore(entry.name)
            const isFirst = entry.rank === 1
            const isOpen  = expanded === entry.rank
            const hasReason = !!entry.beats_next_because

            return (
              <div key={entry.rank}>
                <button type="button"
                  onClick={() => setExpanded(isOpen ? null : entry.rank)}
                  className="w-full grid grid-cols-12 px-4 py-3.5 text-left transition-colors"
                  style={{
                    background: isFirst?'rgba(16,185,129,0.08)': i%2===0?'rgba(255,255,255,0.02)':'transparent',
                    borderTop: i===0?'none':'1px solid rgba(255,255,255,0.06)',
                    cursor: hasReason?'pointer':'default',
                  }}>
                  {/* Rank */}
                  <div className="col-span-1 flex items-center justify-center">
                    <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                      style={{ background: isFirst?'rgba(16,185,129,0.25)':'rgba(255,255,255,0.08)', color: isFirst?'#34d399':'rgba(255,255,255,0.5)' }}>
                      {entry.rank}
                    </span>
                  </div>
                  {/* Name */}
                  <div className="col-span-4 flex items-center">
                    <span className="text-sm font-semibold" style={{color: isFirst?'#ecfdf5':'rgba(255,255,255,0.85)'}}>
                      {entry.name}
                    </span>
                  </div>
                  {/* Score */}
                  <div className="col-span-2 flex items-center justify-center">
                    {score != null ? (
                      <span className="text-sm font-black" style={{color: scoreColor(score)}}>{score}<span className="text-xs font-normal" style={{color:'rgba(255,255,255,0.3)'}}>/10</span></span>
                    ) : (
                      <span className="text-xs" style={{color:'rgba(255,255,255,0.3)'}}>—</span>
                    )}
                  </div>
                  {/* Verdict */}
                  <div className="col-span-4 flex items-center">
                    <span className="text-xs leading-snug" style={{color:'rgba(255,255,255,0.6)'}}>{entry.one_line_verdict}</span>
                  </div>
                  {/* Expand chevron */}
                  <div className="col-span-1 flex items-center justify-end">
                    {hasReason && (
                      <motion.svg animate={{rotate: isOpen?180:0}} transition={{duration:0.2}}
                        className="w-3.5 h-3.5" style={{color:'rgba(255,255,255,0.25)'}}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                      </motion.svg>
                    )}
                  </div>
                </button>

                {/* Expandable drawer */}
                <AnimatePresence>
                  {isOpen && hasReason && (
                    <motion.div
                      initial={{opacity:0,height:0}} animate={{opacity:1,height:'auto'}} exit={{opacity:0,height:0}}
                      transition={{duration:0.22,ease:'easeOut'}}
                      className="overflow-hidden px-6 py-3 text-sm"
                      style={{ background:'rgba(99,102,241,0.07)',borderTop:'1px solid rgba(99,102,241,0.15)' }}>
                      <span style={{color:'rgba(255,255,255,0.35)'}}>Why #{entry.rank} beats #{entry.rank+1}: </span>
                      <span style={{color:'rgba(165,180,252,0.9)'}}>{entry.beats_next_because}</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </motion.div>
      )}

      {/* Red flags */}
      {cmp && Object.keys(cmp.red_flags).length > 0 && (
        <motion.div {...card(2)} className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <span className="text-[11px] font-bold uppercase tracking-widest" style={{color:'#fbbf24'}}>
              ⚠ Red Flags
            </span>
          </div>
          {Object.entries(cmp.red_flags).map(([name,flag])=>(
            <div key={name} className="rounded-xl px-4 py-3.5"
              style={{ background:'rgba(245,158,11,0.08)',border:'1px solid rgba(245,158,11,0.22)' }}>
              <span className="text-sm font-bold" style={{color:'#fbbf24'}}>{name}</span>
              <span className="text-sm" style={{color:'rgba(255,255,255,0.65)'}}>: {flag}</span>
            </div>
          ))}
          <p className="text-xs px-1" style={{color:'rgba(255,255,255,0.2)'}}>
            Red flags are AI-generated. Verify independently before use in hiring decisions.
          </p>
        </motion.div>
      )}

      {/* No comparison fallback */}
      {!cmp && results.length > 0 && (
        <motion.div {...card(2)} className="glass rounded-2xl p-5">
          <p className="text-sm font-semibold text-white mb-3">Individual Scores</p>
          <div className="space-y-2.5">
            {[...results].sort((a,b)=>b.score-a.score).map(r=>(
              <div key={r.candidate_name} className="flex items-center justify-between">
                <span className="text-sm" style={{color:'rgba(255,255,255,0.7)'}}>{r.candidate_name}</span>
                <span className="text-sm font-bold" style={{color:scoreColor(r.score)}}>{r.score}/10</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Download */}
      <motion.div {...card(3)} className="grid grid-cols-2 gap-3 pt-1">
        <motion.button onClick={downloadReport} disabled={dlLoading || !cmp}
          whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
          style={{background:'linear-gradient(135deg,#065f46,#059669)',boxShadow:'0 0 40px rgba(16,185,129,0.25)'}}>
          {dlLoading ? (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
          )}
          Download Hiring Report PDF
        </motion.button>
        <motion.button onClick={onReset} whileHover={{scale:1.02,y:-1}} whileTap={{scale:0.98}}
          className="rounded-2xl py-3.5 text-sm font-semibold"
          style={{background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.12)',color:'rgba(255,255,255,0.7)'}}>
          Compare Again
        </motion.button>
      </motion.div>
    </motion.div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Page() {
  // Shared
  const [tab,     setTab]    = useState<Tab>('single')
  const [jobDesc, setJobDesc]= useState('')
  const formTilt = useTilt()
  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null)

  // Single tab
  const [phase,   setPhase]  = useState<Phase>('idle')
  const [file,    setFile]   = useState<File|null>(null)
  const [result,  setResult] = useState<ScreeningResult|null>(null)
  const [error,   setError]  = useState<string|null>(null)
  const [stepIdx, setStepIdx]= useState(0)

  // Compare tab
  const [cPhase,         setCPhase]         = useState<Phase>('idle')
  const [cFiles,         setCFiles]         = useState<File[]>([])
  const [compareResult,  setCompareResult]  = useState<CompareResponse|null>(null)
  const [cError,         setCError]         = useState<string|null>(null)
  const [cStepIdx,       setCStepIdx]       = useState(0)

  // Unified loading step timer
  const isLoading = (tab==='single'&&phase==='loading') || (tab==='compare'&&cPhase==='loading')
  useEffect(()=>{
    if (isLoading) {
      const steps   = tab==='single' ? STEPS : COMPARE_STEPS
      const setIdx  = tab==='single' ? setStepIdx : setCStepIdx
      setIdx(0)
      timerRef.current = setInterval(()=>setIdx(i=>Math.min(i+1,steps.length-1)), 1700)
    } else {
      if(timerRef.current) clearInterval(timerRef.current)
    }
    return ()=>{ if(timerRef.current) clearInterval(timerRef.current) }
  },[isLoading, tab])

  // Single submit
  const submitSingle = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!file||!jobDesc.trim()) return
    setPhase('loading'); setError(null)
    try {
      const body = new FormData()
      body.append('pdf_file', file)
      body.append('job_description', jobDesc.trim())
      const res = await fetch(`${API}/screen`,{method:'POST',body})
      if (!res.ok){ const p=await res.json().catch(()=>({detail:res.statusText})); throw new Error(p?.detail??`HTTP ${res.status}`) }
      setResult(await res.json()); setPhase('result')
    } catch(err){ setError(err instanceof Error?err.message:'Unexpected error.'); setPhase('error') }
  }

  // Compare submit
  const submitCompare = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (cFiles.length < 2 || !jobDesc.trim()) return
    setCPhase('loading'); setCError(null)
    try {
      const body = new FormData()
      body.append('job_description', jobDesc.trim())
      cFiles.forEach(f => body.append('pdf_files', f))
      const res = await fetch(`${API}/compare`,{method:'POST',body})
      if (!res.ok){ const p=await res.json().catch(()=>({detail:res.statusText})); throw new Error(p?.detail??`HTTP ${res.status}`) }
      setCompareResult(await res.json()); setCPhase('result')
    } catch(err){ setCError(err instanceof Error?err.message:'Unexpected error.'); setCPhase('error') }
  }

  const resetSingle  = ()=>{ setPhase('idle'); setResult(null); setError(null); setFile(null) }
  const resetCompare = ()=>{ setCPhase('idle'); setCompareResult(null); setCError(null); setCFiles([]) }

  // View flags
  const showSingleResult  = tab==='single'  && phase==='result'  && !!result
  const showCompareResult = tab==='compare' && cPhase==='result' && !!compareResult
  const showLoading       = isLoading
  const showForm          = !showSingleResult && !showCompareResult && !showLoading

  const activeSteps = tab==='single' ? STEPS : COMPARE_STEPS
  const activeIdx   = tab==='single' ? stepIdx : cStepIdx

  return (
    <div style={{ minHeight:'100vh', background:'#06060f' }}>
      <Background/>
      <div className="relative z-10 min-h-screen flex flex-col">

        {/* Header */}
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
            <div className="hidden sm:flex items-center gap-1.5">
              <motion.div className="w-1.5 h-1.5 rounded-full" style={{background:'#10b981'}}
                animate={{scale:[1,1.6,1],opacity:[1,0.4,1]}} transition={{duration:2,repeat:Infinity}}/>
              <span className="text-xs font-semibold" style={{color:'#6ee7b7'}}>Live</span>
            </div>
          </div>
        </motion.header>

        <main className="flex-1 mx-auto w-full max-w-2xl px-4 pb-12">
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
                className="glass rounded-3xl mt-12">
                <AtomLoader status={activeSteps[activeIdx]}/>
              </motion.div>
            )}

            {/* Form */}
            {showForm && (
              <motion.div key="form" initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-12}}
                transition={{duration:0.45,ease:'easeOut'}}>

                {/* Hero */}
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
                    className="text-sm max-w-md mx-auto leading-relaxed" style={{color:'rgba(255,255,255,0.5)'}}>
                    AI-powered résumé screening with GitHub verification, multi-candidate comparison, and PDF reports.
                  </motion.p>
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

                {/* Tab pills */}
                <motion.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={{delay:0.28}}
                  className="flex rounded-xl p-1 mb-5"
                  style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)'}}>
                  {([
                    { key:'single',  icon:'📄', label:'Screen Candidate' },
                    { key:'compare', icon:'⚖️', label:'Compare Candidates' },
                  ] as const).map(t=>(
                    <button key={t.key} onClick={()=>setTab(t.key)}
                      className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all"
                      style={{
                        background:tab===t.key?'rgba(99,102,241,0.25)':'transparent',
                        color:tab===t.key?'#a5b4fc':'rgba(255,255,255,0.4)',
                        border:tab===t.key?'1px solid rgba(99,102,241,0.35)':'1px solid transparent',
                      }}>
                      {t.icon} {t.label}
                    </button>
                  ))}
                </motion.div>

                {/* Single tab form */}
                {tab==='single' && (
                  <form onSubmit={submitSingle} className="space-y-4">
                    <motion.div ref={formTilt.ref} onMouseMove={formTilt.move} onMouseLeave={formTilt.leave}
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.32}}
                      className="glass tilt-card rounded-2xl p-5">
                      <label className="block text-xs font-bold uppercase tracking-widest mb-3"
                        style={{color:'rgba(255,255,255,0.4)'}}>Job Description</label>
                      <textarea value={jobDesc} onChange={e=>setJobDesc(e.target.value)}
                        rows={6} placeholder="Paste the full job description here…" required minLength={10}
                        className="w-full resize-none rounded-xl px-4 py-3 text-sm outline-none"
                        style={{ background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',color:'#f1f5f9',caretColor:'#818cf8' }}
                        onFocus={e=>{e.target.style.borderColor='rgba(99,102,241,0.5)';e.target.style.boxShadow='0 0 0 3px rgba(99,102,241,0.1)'}}
                        onBlur={e=>{e.target.style.borderColor='rgba(255,255,255,0.1)';e.target.style.boxShadow='none'}}
                      />
                    </motion.div>

                    <motion.div className="glass rounded-2xl p-5"
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.38}}>
                      <label className="block text-xs font-bold uppercase tracking-widest mb-3"
                        style={{color:'rgba(255,255,255,0.4)'}}>Résumé File</label>
                      <FileDropzone file={file} onFile={setFile}/>
                    </motion.div>

                    <AnimatePresence>
                      {phase==='error'&&error&&(
                        <motion.div initial={{opacity:0,y:-6,scale:0.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0}}
                          className="flex items-start gap-3 rounded-2xl px-4 py-3.5 text-sm"
                          style={{background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',color:'#fca5a5'}}>
                          <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" clipRule="evenodd" d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"/>
                          </svg>
                          {error}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <motion.button type="submit" disabled={!file||!jobDesc.trim()}
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.44}}
                      whileHover={{scale:1.01,y:-1}} whileTap={{scale:0.98}}
                      className="w-full flex items-center justify-center gap-2.5 rounded-2xl py-4 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ background:'linear-gradient(135deg,#4338ca,#6d28d9 50%,#0891b2)',boxShadow:'0 0 50px rgba(99,102,241,0.3)' }}>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/>
                      </svg>
                      Screen Candidate
                    </motion.button>
                  </form>
                )}

                {/* Compare tab form */}
                {tab==='compare' && (
                  <form onSubmit={submitCompare} className="space-y-4">
                    <motion.div ref={formTilt.ref} onMouseMove={formTilt.move} onMouseLeave={formTilt.leave}
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.32}}
                      className="glass tilt-card rounded-2xl p-5">
                      <label className="block text-xs font-bold uppercase tracking-widest mb-3"
                        style={{color:'rgba(255,255,255,0.4)'}}>Job Description</label>
                      <textarea value={jobDesc} onChange={e=>setJobDesc(e.target.value)}
                        rows={4} placeholder="Paste the full job description here…" required minLength={10}
                        className="w-full resize-none rounded-xl px-4 py-3 text-sm outline-none"
                        style={{ background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',color:'#f1f5f9',caretColor:'#818cf8' }}
                        onFocus={e=>{e.target.style.borderColor='rgba(99,102,241,0.5)';e.target.style.boxShadow='0 0 0 3px rgba(99,102,241,0.1)'}}
                        onBlur={e=>{e.target.style.borderColor='rgba(255,255,255,0.1)';e.target.style.boxShadow='none'}}
                      />
                    </motion.div>

                    <motion.div className="glass rounded-2xl p-5"
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.38}}>
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-xs font-bold uppercase tracking-widest" style={{color:'rgba(255,255,255,0.4)'}}>
                          Résumé PDFs
                        </label>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: cFiles.length>=2?'rgba(16,185,129,0.15)':'rgba(255,255,255,0.06)', color: cFiles.length>=2?'#34d399':'rgba(255,255,255,0.35)' }}>
                          {cFiles.length} / 10
                        </span>
                      </div>
                      <MultiFileDropzone files={cFiles} onFiles={setCFiles}/>
                    </motion.div>

                    <AnimatePresence>
                      {cPhase==='error'&&cError&&(
                        <motion.div initial={{opacity:0,y:-6,scale:0.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0}}
                          className="flex items-start gap-3 rounded-2xl px-4 py-3.5 text-sm"
                          style={{background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',color:'#fca5a5'}}>
                          <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" clipRule="evenodd" d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"/>
                          </svg>
                          {cError}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <motion.button type="submit" disabled={cFiles.length<2||!jobDesc.trim()}
                      initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} transition={{delay:0.44}}
                      whileHover={{scale:1.01,y:-1}} whileTap={{scale:0.98}}
                      className="w-full flex items-center justify-center gap-2.5 rounded-2xl py-4 text-sm font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ background:'linear-gradient(135deg,#065f46,#059669 50%,#0891b2)',boxShadow:'0 0 50px rgba(16,185,129,0.2)' }}>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                      </svg>
                      Compare {cFiles.length >= 2 ? `${cFiles.length} Candidates` : 'Candidates'}
                    </motion.button>
                  </form>
                )}

                <motion.p initial={{opacity:0}} animate={{opacity:1}} transition={{delay:0.55}}
                  className="text-center text-xs mt-6" style={{color:'rgba(255,255,255,0.2)'}}>
                  {tab==='single'
                    ? 'Results powered by LLaMA-3.3-70b · GitHub data via public API'
                    : 'Two LLM passes: individual screening + comparative analysis'}
                </motion.p>
              </motion.div>
            )}

          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
