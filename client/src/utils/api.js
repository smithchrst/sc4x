import axios from 'axios';
import toast from 'react-hot-toast';

// Create axios instance
const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:5000/api',
  timeout: 10000,
});

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle errors
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      // Token expired or invalid
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
      return Promise.reject(error);
    }

    // Show error message if not handled elsewhere
    if (error.response?.data?.message && !error.config?.skipErrorToast) {
      toast.error(error.response.data.message);
    } else if (!error.config?.skipErrorToast) {
      toast.error('An unexpected error occurred');
    }

    return Promise.reject(error);
  }
);

// Auth API
export const authAPI = {
  login: (credentials) => api.post('/auth/login', credentials),
  me: () => api.get('/auth/me'),
  refresh: () => api.post('/auth/refresh'),
  changePassword: (data) => api.post('/auth/change-password', data),
};

// Users API
export const usersAPI = {
  getAll: () => api.get('/users'),
  getById: (id) => api.get(`/users/${id}`),
  create: (data) => api.post('/users', data),
  update: (id, data) => api.put(`/users/${id}`, data),
  delete: (id) => api.delete(`/users/${id}`),
  resetPassword: (id, data) => api.post(`/users/${id}/reset-password`, data),
  getStats: (id) => api.get(`/users/${id}/stats`),
};

// Categories API
export const categoriesAPI = {
  getAll: () => api.get('/categories'),
  getFlat: () => api.get('/categories/flat'),
  getById: (id) => api.get(`/categories/${id}`),
  create: (data) => api.post('/categories', data),
  update: (id, data) => api.put(`/categories/${id}`, data),
  delete: (id) => api.delete(`/categories/${id}`),
};

// Products API
export const productsAPI = {
  getAll: (params) => api.get('/products', { params }),
  getById: (id) => api.get(`/products/${id}`),
  create: (data) => {
    const formData = new FormData();
    Object.keys(data).forEach(key => {
      if (data[key] !== null && data[key] !== undefined) {
        formData.append(key, data[key]);
      }
    });
    return api.post('/products', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },
  update: (id, data) => {
    const formData = new FormData();
    Object.keys(data).forEach(key => {
      if (data[key] !== null && data[key] !== undefined) {
        formData.append(key, data[key]);
      }
    });
    return api.put(`/products/${id}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },
  delete: (id) => api.delete(`/products/${id}`),
  search: (term) => api.get(`/products/search/${term}`),
};

// Stock API
export const stockAPI = {
  getAll: (params) => api.get('/stock', { params }),
  getMovements: (params) => api.get('/stock/movements', { params }),
  adjust: (data) => api.post('/stock/adjust', data),
  bulkAdjust: (data) => api.post('/stock/bulk-adjust', data),
  getAlerts: (params) => api.get('/stock/alerts', { params }),
  acknowledgeAlert: (id) => api.put(`/stock/alerts/${id}/acknowledge`),
};

// Sales API
export const salesAPI = {
  getAll: (params) => api.get('/sales', { params }),
  getById: (id) => api.get(`/sales/${id}`),
  create: (data) => api.post('/sales', data),
  refund: (id, data) => api.post(`/sales/${id}/refund`, data),
  getAnalytics: (params) => api.get('/sales/analytics/summary', { params }),
  getRecent: (params) => api.get('/sales/recent', { params }),
};

// Dashboard API
export const dashboardAPI = {
  getOverview: () => api.get('/dashboard/overview'),
  getRecentActivity: () => api.get('/dashboard/recent-activity'),
  getTopProducts: (params) => api.get('/dashboard/top-products', { params }),
  getSalesChart: (params) => api.get('/dashboard/sales-chart', { params }),
  getInventoryStatus: () => api.get('/dashboard/inventory-status'),
  getLowStockProducts: (params) => api.get('/dashboard/low-stock-products', { params }),
  getCashierPerformance: (params) => api.get('/dashboard/cashier-performance', { params }),
};

// Helper functions
export const handleApiError = (error, defaultMessage = 'An error occurred') => {
  if (error.response?.data?.message) {
    return error.response.data.message;
  }
  return defaultMessage;
};

export const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount || 0);
};

export const formatDate = (date) => {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
};

export const formatDateOnly = (date) => {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(date));
};

export default api;