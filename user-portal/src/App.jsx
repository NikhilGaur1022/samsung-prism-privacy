import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppLayout from './components/AppLayout'
import Login from './pages/Login'
import Register from './pages/Register'
import Verify from './pages/Verify'
import Enroll from './pages/Enroll'
import Join from './pages/Join'
import Dashboard from './pages/Dashboard'
import ConsentHub from './pages/ConsentHub'
import ProjectDetails from './pages/ProjectDetails'
import DataRights from './pages/DataRights'
import Projects from './pages/Projects'
import Profile from './pages/Profile'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify" element={<Verify />} />
        {/* Outside AppLayout: the user has a subject session but has not finished
            onboarding, and a phone walk-up should not land on a sidebar. */}
        <Route path="/enroll" element={<Enroll />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/consent" element={<ConsentHub />} />
          <Route path="/consent/:projectId" element={<ProjectDetails />} />
          <Route path="/rights" element={<DataRights />} />
          <Route path="/profile" element={<Profile />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
