import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || 'เกิดข้อผิดพลาดที่ไม่คาดคิด',
    };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application ErrorBoundary caught:', error, info);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full bg-[#0b0f19] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[#121929] border border-[#26334d] rounded-2xl p-6 text-center space-y-4">
            <div className="w-12 h-12 rounded-xl bg-red-950/60 border border-red-500/40 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-5 h-5 text-red-400" aria-hidden="true" />
            </div>
            <div>
              <h1 className="font-display text-lg font-bold text-slate-100">
                ไม่สามารถโหลดหน้าต่างนี้ได้ชั่วคราว
              </h1>
              <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
                ระบบพบข้อผิดพลาดระหว่างประมวลผล กรุณารีเฟรชหน้าจอเพื่อเริ่มต้นใหม่อีกครั้ง
              </p>
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>โหลดหน้าใหม่</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
