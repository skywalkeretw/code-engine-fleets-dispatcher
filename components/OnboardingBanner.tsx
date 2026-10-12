'use client'

/**
 * OnboardingBanner — dismissible introduction panel shown on first visit.
 *
 * Uses localStorage key "dispatcher_onboarding_dismissed" to remember the
 * dismissal. Re-appears if localStorage is cleared.
 * Not shown during SSR (localStorage is browser-only).
 */

import { useState, useEffect } from 'react'

const STORAGE_KEY = 'dispatcher_onboarding_dismissed'

export default function OnboardingBanner() {
  const [visible, setVisible] = useState(false)

  // Hydrate after mount (localStorage is browser-only, not available during SSR)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const dismissed = localStorage.getItem(STORAGE_KEY)
      if (!dismissed) setVisible(true)
    }
  }, [])

  function dismiss() {
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, '1')
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div style={{
      background: '#edf5ff',
      border: '1px solid #a8c8ff',
      padding: '1rem 1.25rem',
      marginBottom: '1.25rem',
      position: 'relative',
    }}>
      <button
        onClick={dismiss}
        title="Dismiss"
        aria-label="Dismiss introduction"
        style={{
          position: 'absolute', top: 10, right: 12,
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: '1.125rem', color: '#525252', lineHeight: 1,
        }}
      >
        ✕
      </button>

      <p style={{ fontWeight: 700, fontSize: '0.9375rem', marginBottom: '0.625rem' }}>
        👋 Welcome to the Fleets Dispatcher
      </p>

      <p style={{ fontSize: '0.8125rem', color: '#161616', lineHeight: 1.6, marginBottom: '0.875rem' }}>
        This tool lets you dispatch a batch of files to an <strong>IBM Code Engine Serverless Fleet</strong>{' '}
        for parallel processing — without writing any code.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' }}>
        {[
          { step: '1', title: 'Fleet', body: 'An IBM Code Engine Serverless Fleet is a pool of standby workers ready to process tasks. You select which fleet will run your job.' },
          { step: '2', title: 'Task Template', body: 'A template defines what command each worker runs and what arguments it receives. Use {{filename}}, {{cosPath}}, and mount placeholders to reference your files.' },
          { step: '3', title: 'Files', body: 'Drag in the files you want to process. Each file becomes one task line in the JSONL sent to the fleet. Files are uploaded to IBM Cloud Object Storage (COS).' },
          { step: '4', title: 'JSONL Preview', body: 'Review the exact task definitions before they are sent. JSONL (JSON Lines) is one task per line — each line tells a worker what to do with one file.' },
          { step: '5', title: 'Submit', body: 'Click Upload & Dispatch to upload all files to COS, then submit the task list to your fleet. Workers start immediately.' },
        ].map(({ step, title, body }) => (
          <div key={step} style={{ background: '#fff', border: '1px solid #c6e0ff', padding: '0.625rem 0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: '0.375rem' }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%',
                background: '#0f62fe', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.6875rem', fontWeight: 700, flexShrink: 0,
              }}>{step}</span>
              <strong style={{ fontSize: '0.8125rem' }}>{title}</strong>
            </div>
            <p style={{ fontSize: '0.75rem', color: '#525252', lineHeight: 1.5, margin: 0 }}>{body}</p>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <p style={{ fontSize: '0.75rem', color: '#525252', margin: 0 }}>
          <strong>Glossary:</strong>{' '}
          <em>Fleet</em> = pool of standby CE workers ·{' '}
          <em>JSONL</em> = one task per line ·{' '}
          <em>TSS</em> = Task State Store (tracks task completion) ·{' '}
          <em>COS prefix</em> = folder-like path prefix for uploaded files in the bucket
        </p>
        <button
          onClick={dismiss}
          style={{
            background: '#0f62fe', color: '#fff', border: 'none',
            padding: '6px 16px', cursor: 'pointer', fontSize: '0.8125rem',
            borderRadius: 2, flexShrink: 0,
          }}
        >
          Got it, dismiss
        </button>
      </div>
    </div>
  )
}
