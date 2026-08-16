import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, RequireRole } from './auth'
import { ROLES } from './roles'
import Login from './pages/Login'
import AcceptInvite from './pages/AcceptInvite'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import Dashboard from './pages/Dashboard'
import Placeholder from './pages/Placeholder'
import ProjectApprovals from './pages/dpo/ProjectApprovals'
import ConsentTemplates from './pages/dpo/ConsentTemplates'
import RequestOversight from './pages/dpo/RequestOversight'
import SlaMonitoring from './pages/dpo/SlaMonitoring'
import ComplianceReports from './pages/dpo/ComplianceReports'
import DsarQueue from './pages/dataAdmin/DsarQueue'
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
import Tagging from './pages/collectionAgent/Tagging'
import ReviewPhotos from './pages/collectionAgent/ReviewPhotos'
import People from './pages/collectionAgent/People'

const PAGE_COMPONENTS = {
  '/project-approvals': ProjectApprovals,
  '/consent-templates': ConsentTemplates,
  '/request-oversight': RequestOversight,
  '/sla-monitoring': SlaMonitoring,
  '/compliance-reports': ComplianceReports,
  '/dsar-queue': DsarQueue,
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
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route
            path="/sessions/:sessionId"
            element={
              <RequireRole allow={['collectionAgent']}>
                <SessionDetail />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/audio"
            element={
              <RequireRole allow={['collectionAgent']}>
                <AudioSessionDetail />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/tagging"
            element={
              <RequireRole allow={['collectionAgent']}>
                <Tagging />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/people"
            element={
              <RequireRole allow={['collectionAgent']}>
                <People />
              </RequireRole>
            }
          />
          <Route
            path="/sessions/:sessionId/review"
            element={
              <RequireRole allow={['collectionAgent']}>
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
          {Object.values(ROLES).flatMap((role) =>
            role.nav.map(({ label, path }) => {
              const Page = PAGE_COMPONENTS[path]
              return (
                <Route
                  key={path}
                  path={path}
                  element={
                    <RequireRole allow={[role.key]}>
                      {Page ? <Page /> : <Placeholder label={label} />}
                    </RequireRole>
                  }
                />
              )
            }),
          )}
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
