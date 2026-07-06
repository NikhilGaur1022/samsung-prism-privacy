import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppLayout from './components/AppLayout'
import Login from './pages/Login'
import Verify from './pages/Verify'
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
        <Route path="/verify" element={<Verify />} />
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
