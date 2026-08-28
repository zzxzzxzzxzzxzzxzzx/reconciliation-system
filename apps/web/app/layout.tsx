import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '抖店对账系统',
  description: '抖店订单、结算与历史成本对账后台',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
