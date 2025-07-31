import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';

// Components
import LoadingSpinner from './components/common/LoadingSpinner';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import ProductForm from './pages/ProductForm';
import Categories from './pages/Categories';
import Stock from './pages/Stock';
import Sales from './pages/Sales';
import POS from './pages/POS';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Layout from './components/layout/Layout';

// Protected Route Component
const ProtectedRoute = ({ children, requiredPermission }) => {
  const { isAuthenticated, isLoading, hasPermission } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (requiredPermission && !hasPermission(requiredPermission)) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
};

// Public Route Component (redirect if authenticated)
const PublicRoute = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
};

// App Routes Component
const AppRoutes = () => {
  return (
    <Routes>
      {/* Public Routes */}
      <Route
        path="/login"
        element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        }
      />

      {/* Protected Routes */}
      <Route
        path="/"
        element={
          <ProtectedRoute requiredPermission="staff">
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        
        {/* Dashboard - Available to all staff */}
        <Route path="dashboard" element={<Dashboard />} />
        
        {/* POS - Available to all staff */}
        <Route path="pos" element={<POS />} />
        
        {/* Products - Available to all staff */}
        <Route path="products" element={<Products />} />
        <Route 
          path="products/new" 
          element={
            <ProtectedRoute requiredPermission="admin">
              <ProductForm />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="products/:id/edit" 
          element={
            <ProtectedRoute requiredPermission="admin">
              <ProductForm />
            </ProtectedRoute>
          } 
        />
        
        {/* Categories - Admin only */}
        <Route 
          path="categories" 
          element={
            <ProtectedRoute requiredPermission="admin">
              <Categories />
            </ProtectedRoute>
          } 
        />
        
        {/* Stock Management - Available to all staff */}
        <Route path="stock" element={<Stock />} />
        
        {/* Sales - Available to all staff */}
        <Route path="sales" element={<Sales />} />
        
        {/* User Management - Admin only */}
        <Route 
          path="users" 
          element={
            <ProtectedRoute requiredPermission="admin">
              <Users />
            </ProtectedRoute>
          } 
        />
        
        {/* Settings - Available to all staff */}
        <Route path="settings" element={<Settings />} />
      </Route>

      {/* Catch all route */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
};

// Main App Component
function App() {
  return (
    <AuthProvider>
      <Router>
        <div className="App">
          <AppRoutes />
          <Toaster
            position="top-right"
            toastOptions={{
              duration: 4000,
              style: {
                background: '#363636',
                color: '#fff',
              },
              success: {
                duration: 3000,
                iconTheme: {
                  primary: '#22c55e',
                  secondary: '#fff',
                },
              },
              error: {
                duration: 5000,
                iconTheme: {
                  primary: '#ef4444',
                  secondary: '#fff',
                },
              },
            }}
          />
        </div>
      </Router>
    </AuthProvider>
  );
}

export default App;