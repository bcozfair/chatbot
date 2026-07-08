import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { User, Lock, Eye, EyeOff, AlertCircle, Loader2 } from 'lucide-react';

export const Login: React.FC = () => {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: username.trim(),
          password: password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง');
        setIsSubmitting(false);
        return;
      }

      if (data.token && data.user) {
        login(data.token, data.user);
      } else {
        setError('เกิดข้อผิดพลาดในการตรวจสอบสิทธิ์');
      }
    } catch (err) {
      console.error('Login error:', err);
      setError('ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-slate-50 text-slate-800 flex flex-col items-center justify-center p-4 overflow-hidden">
      {/* Soft Decorative Glowing Blobs */}
      <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-[#009032]/5 rounded-full blur-[100px] pointer-events-none"></div>
      <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-96 h-96 bg-emerald-600/5 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="max-w-md w-full z-10">
        {/* Company Logo and Title */}
        <div className="flex flex-col items-center mb-8 text-center">
          <div className="w-24 h-24 p-3 bg-white border border-slate-200 rounded-2xl shadow-md flex items-center justify-center mb-4">
            <img 
              src="/logo.png" 
              alt="Primus Co., Ltd. Logo" 
              className="w-full h-full object-contain"
            />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 mb-1">
            Admin Portal
          </h1>
          <p className="text-slate-500 text-sm font-medium">
            ระบบจัดการหลังบ้าน บริษัท ไพรมัส จำกัด
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-white/80 border border-slate-200/80 rounded-3xl p-8 shadow-2xl shadow-slate-200/80 backdrop-blur-xl relative overflow-hidden">
          {/* Card light header line */}
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"></div>

          <form onSubmit={handleSubmit} autoComplete="on" className="space-y-6">
            {/* Error Alert */}
            {error && (
              <div className="flex items-center gap-3 bg-red-50 border border-red-200 p-4 rounded-xl text-red-800 text-sm">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Username Input */}
            <div className="space-y-2">
              <label htmlFor="username-input" className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">
                ชื่อผู้ใช้งาน (Username)
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-[#009032] transition-colors">
                  <User className="w-5 h-5" />
                </div>
                <input
                  id="username-input"
                  name="username"
                  autoComplete="username"
                  type="text"
                  required
                  disabled={isSubmitting}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className="w-full bg-white border border-slate-200 rounded-xl pl-11 pr-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
            </div>

            {/* Password Input */}
            <div className="space-y-2">
              <label htmlFor="password-input" className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">
                รหัสผ่าน (Password)
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-[#009032] transition-colors">
                  <Lock className="w-5 h-5" />
                </div>
                <input
                  id="password-input"
                  name="password"
                  autoComplete="current-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  disabled={isSubmitting}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-white border border-slate-200 rounded-xl pl-11 pr-11 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <button
                  id="toggle-password-btn"
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              id="login-submit-btn"
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-[#009032] to-emerald-600 hover:from-[#009032]/95 hover:to-emerald-600/95 active:scale-[0.98] transition-all text-white font-semibold rounded-xl shadow-md shadow-emerald-600/10 hover:shadow-emerald-600/25 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:scale-100"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>กำลังเข้าสู่ระบบ...</span>
                </>
              ) : (
                <span>เข้าสู่ระบบ</span>
              )}
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-xs text-slate-400">
          <p>© {new Date().getFullYear()} Primus Co., Ltd. All rights reserved.</p>
        </div>
      </div>
    </div>
  );
};
