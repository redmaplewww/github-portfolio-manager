import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GitHub 代码版图",
  description: "独立追踪 GitHub 仓库、Pull Request、协作者与开发事实。",
  applicationName: "GitHub 代码版图",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "GitHub 代码版图" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
