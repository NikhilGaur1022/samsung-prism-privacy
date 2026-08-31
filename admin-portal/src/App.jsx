import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, RequireRole } from './auth'
import { PAGES } from './roles'
import ErrorBoundary from './components/ErrorBoundary'
import UnsupportedViewport from './components/UnsupportedViewport'
import NotFound from './pages/NotFound'
import Login from './pages/Login'
import AcceptInvite from './pages/AcceptInvite'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import Dashboard from './pages/Dashboard'
import Placeholder from './pages/Placeholder'
import ProjectApprovals from './pages/dpo/ProjectApprovals'
import ConsentTemplates from './pages/dpo/ConsentTemplates'
import ImageProvenance from './pages/dpo/ImageProvenance'
import SlaMonitoring from './pages/dpo/SlaMonitoring'
import ComplianceReports from './pages/dpo/ComplianceReports'
import DsarQueue from './pages/dataAdmin/DsarQueue'
import DsarRequestDetail from './pages/dataAdmin/DsarRequestDetail'
import ImportData from './pages/dataAdmin/ImportData'
import CollectionSessions from './pages/dataAdmin/CollectionSessions'
import QueueHealth from './pages/dataAdmin/QueueHealth'
import DiscoveryWorkspace from './pages/dataAdmin/DiscoveryWorkspace'
import DataLineage from './pages/dataAdmin/DataLineage'
import PurgeExport from './pages/dataAdmin/PurgeExport'
import EvidenceVault from './pages/dataAdmin/EvidenceVault'
import AuditLogs from './pages/dataAdmin/AuditLogs'
import MyProjects from './pages/dataOwner/MyProjects'
import CreateProject from './pages/dataOwner/CreateProject'
import DataRequirements from './pages/dataOwner/DataRequirements'
import CollectionProgress from './pages/dataOwner/CollectionProgress'
import ProcessedData from './pages/dataOwner/ProcessedData'
import ProjectReports from './pages/dataOwner/ProjectReports'
import Assignments from './pages/collectionAgent/Assignments'
import NewSession from './pages/collectionAgent/NewSession'
import SubjectVerification from './pages/collectionAgent/SubjectVerification'
import ConsentCheck from './pages/collectionAgent/ConsentCheck'
import Sessions from './pages/collectionAgent/Sessions'
import SessionDetail from './pages/collectionAgent/SessionDetail'
import AudioSessionDetail from './pages/collectionAgent/AudioSessionDetail'
import TextSessionDetail from './pages/collectionAgent/TextSessionDetail'
import Tagging from './pages/collectionAgent/Tagging'
import ReviewPhotos from './pages/collectionAgent/ReviewPhotos'
import People from './pages/collectionAgent/People'
import SessionPhotos from './pages/SessionPhotos'

const PAGE_COMPONENTS = {
  '/project-approvals': ProjectApprovals,
  '/consent-templates': ConsentTemplates,
  '/image-provenance': ImageProvenance,
  '/sla-monitoring': SlaMonitoring,
  '/compliance-reports': ComplianceReports,
  '/dsar-queue': DsarQueue,
  '/import': ImportData,
  '/collection-sessions': CollectionSessions,
  '/discovery-workspace': DiscoveryWorkspace,
  '/data-lineage': DataLineage,
  '/purge-export': PurgeExport,
  '/evidence-vault': EvidenceVault,
  '/audit-logs': AuditLogs,
  '/my-projects': MyProjects,
  '/create-project': CreateProject,
  '/data-requirements': DataRequirements,
  '/collection-progress': CollectionProgress,
  '/processed-data': ProcessedData,
  '/project-reports': ProjectReports,
  '/assignments': Assignments,
  '/new-session': NewSession,
  '/subject-verification': SubjectVerification,
  '/consent-check': ConsentCheck,
  '/sessions': Sessions,
  '/queue-health': QueueHealth,
}

// Vite's BASE_URL always carries a trailing slash ("/admin/"), and React Router
// cannot use it in that form. Its stripBasename does a literal startsWith, so
// with basename "/admin/" the pathname "/admin" — no trailing slash — does not
// match, matchRoutes returns null, and the router renders NOTHING. The console
// comes up as a blank white page with no error, no failed request, and every
// server-side check returning 200, because the server did its job perfectly.
//
// "/admin/" and "/admin/anything" work, so the bug hides: it only appears on
// the bare URL, which is exactly the one people type and bookmark. Dropping the
// trailing slash matches both forms — stripBasename then checks that the next
// character is "/" or end-of-string, so "/admin" and "/admin/sessions" both
// resolve and "/administrator" correctly does not.
//
// "/" is left alone: React Router special-cases it, and "" would break the
// startsWith check for every path.
export function routerBasename(base) {
  if (!base || base === '/') return '/'
  return base.endsWith('/') ? base.slice(0, -1) : base
}

export default function App() {
  return (
    // Wraps the whole router. Until this existed a thrown render presented as a
    // blank white page with the real error only in the console — which is what
    // made the /requests/new crash look like a failed fetch for a whole session.
    <ErrorBoundary>
      {/* Below the 1024px supported floor the console says so rather than
          rendering at 3.4x the viewport with content clipped mid-word. */}
      <UnsupportedViewport />
      <AuthProvider>
        {/* basename, not "/": both SPAs and the API are served from a single
            origin in the deployed stack (deploy/staging), with the admin console
            mounted under /admin. Vite's BASE_URL carries whatever `base` the
            build used, so this is "/" in dev and "/admin/" in that build with no
            second knob to keep in sync — see routerBasename for why that value
            cannot be handed to BrowserRouter as-is. */}
        <BrowserRouter basename={routerBasename(import.meta.env.BASE_URL)}>
          <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          {/* Oversight view of one session's redacted set. Deliberately NOT open to
              collectionAgent — that role has SessionDetail, which shows the same
              session with the roster and the capture controls it still needs. */}
          {/* dpo is deliberately NOT here, and the Image Provenance page hides
              its session link for that role as a result. session.routes.js gives
              the reason at its mediaReaders guard: matrix §A says dpo "cannot
              see any personal data", and a blurred bystander is still a
              photograph of the consented subject. Adding the role here would
              403 on the API anyway — mediaReaders is
              requireRole('collectionAgent','dataOwner','dataAdmin','super_admin')
              — so the link would be both a dead end and a policy regression. The
              provenance page renders the session record inline instead. */}
          <Route
            path="/sessions/:sessionId/photos"
            element={
              <RequireRole allow={['dataOwner', 'dataAdmin', 'super_admin']}>
                <SessionPhotos />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId"
            element={
              <RequireRole allow={['collectionAgent', 'super_admin']}>
                <SessionDetail />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/audio"
            element={
              // super_admin, like every other session route in this file. The
              // API already admits it here — recordingRoutes' captureRoles is
              // requireRole('collectionAgent', 'super_admin') — so leaving it
              // out made the portal stricter than the endpoint it calls: the
              // platform administrator was refused a page the server would have
              // served, on a role whose whole purpose is break-glass reach.
              <RequireRole allow={['collectionAgent', 'super_admin']}>
                <AudioSessionDetail />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/text"
            element={
              // Same as /audio above: documentRoutes' textRoles already admits
              // super_admin.
              <RequireRole allow={['collectionAgent', 'super_admin']}>
                <TextSessionDetail />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/tagging"
            element={
              <RequireRole allow={['collectionAgent', 'super_admin']}>
                <Tagging />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/people"
            element={
              <RequireRole allow={['collectionAgent', 'super_admin']}>
                <People />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/review"
            element={
              <RequireRole allow={['collectionAgent', 'super_admin']}>
                <ReviewPhotos />
              </RequireRole>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireRole>
                <Dashboard />
              </RequireRole>
            }
          />
          {/* One route per page, carrying every role that page admits. The old
              generator walked ROLES[].nav and emitted allow={[role.key]}, which
              made a shared page reachable by exactly one of the roles that share
              it — and made super_admin, which had no nav array, reach nothing. */}
          {PAGES.map(({ path, label, roles }) => {
            const Page = PAGE_COMPONENTS[path]
            return (
              <Route
                key={path}
                path={path}
                element={
                  <RequireRole allow={roles}>
                    {Page ? <Page /> : <Placeholder label={label} />}
                  </RequireRole>
                }
              />
            )
          })}
          {/* The request workspace. Not in PAGES because it is a parameterised
              route with no nav entry of its own — every role reaches it by
              clicking a row in the DSAR queue. The page itself is role-aware:
              dataOwner never fires the item grid, timeline or actions endpoints,
              which are dpo/dataAdmin/super_admin only. */}
          <Route
            path="/dsar/:requestId"
            element={
              <RequireRole allow={['dataAdmin', 'dpo', 'dataOwner', 'super_admin']}>
                <DsarRequestDetail />
              </RequireRole>
            }
          />
          <Route path="/" element={<Navigate to="/login" replace />} />
          {/* A real 404. This used to redirect to /login, which rendered
              byte-identically to the sign-in page — so a stale link told a
              signed-in admin they had been logged out. */}
          <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}
