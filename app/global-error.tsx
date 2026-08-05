"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    console.error("[global-error]", error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body>
        <main className="app-error" role="alert">
          <section>
            <p>江湖暂起波折</p>
            <h1>应用暂时无法继续</h1>
            <p>请重新尝试，或返回游戏入口。</p>
            <button type="button" onClick={reset}>重新尝试</button>
            <button type="button" onClick={() => router.push("/")}>返回游戏入口</button>
          </section>
        </main>
      </body>
    </html>
  );
}
