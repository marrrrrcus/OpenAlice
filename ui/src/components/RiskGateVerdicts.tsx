import type { RiskGateStatus } from '../api/types'

/**
 * Shared risk-gate verdict card — rendered from a full `RiskGateStatus`
 * wherever one surfaces (advisory preview in PushApprovalPanel, push-time
 * blocked report in OrderEntryDialog). Positioning copy ("preview",
 * "blocked at push", …) belongs to the call site, not here.
 *
 * Language discipline: a full pass reads "no hard-limit block detected",
 * never "safe". Wording comes from the backend; the UI renders, it does
 * not editorialize.
 */
export function RiskGateVerdicts({ riskGates }: { riskGates: RiskGateStatus }) {
  return (
    <div className="space-y-0.5">
      <div
        className={`text-[11px] px-2 py-1 rounded border ${
          riskGates.result === 'BLOCK'
            ? 'text-red border-red/40 bg-red/5'
            : 'text-text-muted border-border bg-bg/50'
        }`}
      >
        Risk gates ({riskGates.mode}):{' '}
        {riskGates.result === 'BLOCK' ? 'BLOCK' : 'no hard-limit block detected'}
      </div>
      {riskGates.verdicts
        .filter(v => v.result === 'BLOCK' || v.code)
        .map((v, i) => (
          <div
            key={i}
            className={`text-[11px] font-mono px-2 py-1 rounded bg-bg/50 ${
              v.result === 'BLOCK' ? 'text-red' : 'text-yellow'
            }`}
          >
            {v.result === 'BLOCK' ? '⛔' : '⚠️'} {v.gate}: {v.reason}
          </div>
        ))}
    </div>
  )
}
