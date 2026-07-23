import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PageHeaderActions } from '../components/HeaderActions';
import { EmptyState } from '../components/Ui';

export function NotFoundPage() {
  return (
    <>
      <PageHeaderActions><Link className="focus-ring inline-flex min-h-8 items-center gap-2 border border-primary bg-primary px-2.5 py-1.5 font-mono text-[12px] text-on-primary transition hover:border-primary-active hover:bg-primary-active" style={{ borderRadius: 2 }} to="/"><ArrowLeft className="h-3.5 w-3.5" />返回市场总览</Link></PageHeaderActions>
      <div className="panel"><EmptyState title="页面不存在" description="这个路由没有对应的量化模块。" /></div>
    </>
  );
}
