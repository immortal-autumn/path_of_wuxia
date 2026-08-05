"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[ui:error-boundary]", error);
  }, [error]);

  return (
    <main className="app-error" role="alert">
      <section>
        <p>江湖暂起波折</p>
        <h1>当前界面无法继续显示</h1>
        <p>你的存档仍保存在服务器中，可以重新加载本界面。</p>
        <button type="button" onClick={reset}>重新尝试</button>
        <Link href="/">返回游戏入口</Link>
      </section>
    </main>
  );
}
