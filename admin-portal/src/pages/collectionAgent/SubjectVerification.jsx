import { useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { listSubjects, registerSubject, verifySubjectOtp } from '../../lib/api'
import { UserCheck, UserPlus } from 'lucide-react'

const GROUPS = [
  { value: 'SAMSUNG_EMPLOYEE', label: 'Samsung Employee' },
  { value: 'EX_SAMSUNG_EMPLOYEE', label: 'Ex-Samsung Employee' },
  { value: 'SEED_LAB_EMPLOYEE', label: 'Seed Lab Employee' },
  { value: 'EX_SEED_LAB_EMPLOYEE', label: 'Ex-Seed Lab Employee' },
  { value: 'VOLUNTEER', label: 'Volunteer' },
]

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function SubjectVerification() {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, loading, error } = useMockQuery(() => listSubjects({ limit: 50 }), [refreshKey])

  const [group, setGroup] = useState(GROUPS[0].value)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [employeeRef, setEmployeeRef] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState(null)
  const [verifyingId, setVerifyingId] = useState(null)
  const [otpInputs, setOtpInputs] = useState({})
  const [verifyError, setVerifyError] = useState(null)

  const subjects = data?.items ?? []

  const handleAddSubject = async (e) => {
    e.preventDefault()
    if (!fullName.trim() || !email.trim() || submitting) return

    setSubmitting(true)
    setFormError(null)

    try {
      await registerSubject({
        group,
        fullName: fullName.trim(),
        email: email.trim(),
        employeeRef: employeeRef.trim() || undefined,
        registrationChannel: 'AGENT',
      })
      setFullName('')
      setEmail('')
      setEmployeeRef('')
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setFormError(err.message ?? 'Could not register subject.')
    } finally {
      setSubmitting(false)
    }
  }

  // The subject receives the code by email — the agent asks them to read it
  // aloud and enters it here rather than the old stub that accepted anything.
  const handleVerify = async (subjectEmail, masterUserId) => {
    const otp = otpInputs[masterUserId]?.trim()
    if (!otp) return

    setVerifyingId(masterUserId)
    setVerifyError(null)
    try {
      await verifySubjectOtp(subjectEmail, otp)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setVerifyError(err.message ?? 'Verification failed.')
    } finally {
      setVerifyingId(null)
    }
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Subject Verification"
          subtitle="Register and confirm the data subject's identity before starting collection."
        />

        <div className="mt-6 max-w-xl rounded-card bg-surface p-6 shadow-card">
          <h2 className="text-sm font-bold text-ink">Register new subject</h2>
          <form onSubmit={handleAddSubject} className="mt-3 grid grid-cols-2 gap-4">
            <label className="col-span-2 block text-sm font-semibold text-ink sm:col-span-1">
              Group
              <select className={FIELD_CLASS} value={group} onChange={(e) => setGroup(e.target.value)}>
                {GROUPS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="col-span-2 block text-sm font-semibold text-ink sm:col-span-1">
              Employee / Seed Lab ref (optional)
              <input
                className={FIELD_CLASS}
                value={employeeRef}
                onChange={(e) => setEmployeeRef(e.target.value)}
                placeholder="e.g. SL-2003"
              />
            </label>

            <label className="col-span-2 block text-sm font-semibold text-ink sm:col-span-1">
              Full name
              <input
                className={FIELD_CLASS}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Full name"
                required
              />
            </label>

            <label className="col-span-2 block text-sm font-semibold text-ink sm:col-span-1">
              Email
              <input
                type="email"
                className={FIELD_CLASS}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="subject@example.com"
                required
              />
            </label>

            {formError && <p className="col-span-2 text-sm font-semibold text-danger">{formError}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="col-span-2 flex w-fit items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              <UserPlus size={16} strokeWidth={2} /> {submitting ? 'Registering…' : 'Register subject'}
            </button>
          </form>
        </div>

        <div className="mt-6">
          {verifyError && <p className="mb-3 text-sm font-semibold text-danger">{verifyError}</p>}
          <ListPanel
            title="Subjects"
            rows={subjects}
            loading={loading}
            error={error}
            emptyTitle="No subjects to verify"
            renderRow={(s) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{s.fullName}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {s.employeeRef ?? s.email ?? s.group}
                  </p>
                </div>
                {s.status === 'ACTIVE' ? (
                  <StatusPill tone="success">Verified</StatusPill>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      value={otpInputs[s.masterUserId] ?? ''}
                      onChange={(e) =>
                        setOtpInputs((prev) => ({ ...prev, [s.masterUserId]: e.target.value }))
                      }
                      placeholder="6-digit code"
                      inputMode="numeric"
                      maxLength={6}
                      className="w-28 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    />
                    <button
                      onClick={() => handleVerify(s.email, s.masterUserId)}
                      disabled={verifyingId === s.masterUserId || !otpInputs[s.masterUserId]?.trim()}
                      className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      <UserCheck size={14} strokeWidth={2} />
                      {verifyingId === s.masterUserId ? 'Verifying…' : 'Verify'}
                    </button>
                  </div>
                )}
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
