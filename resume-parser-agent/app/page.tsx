export default function StatusPage() {
  return (
    <main style={{ maxWidth: 880 }}>
      <h1 style={{ marginTop: 0 }}>Resume Agent — /status</h1>
      <p>Agentic Operator 简历处理工作流，与 RAAS 通过 Inngest 总线协作。</p>

      <h2>已注册 Functions</h2>
      <ul>
        <li>
          <strong>resume-parser-agent</strong> — 订阅 <code>RESUME_DOWNLOADED</code>，发出{' '}
          <code>RESUME_PROCESSED</code>
        </li>
        <li>
          <strong>resume-matcher-agent</strong> — 订阅 <code>RESUME_PROCESSED</code>，发出{' '}
          <code>MATCH_PASSED_NEED_INTERVIEW</code> / <code>MATCH_PASSED_NO_INTERVIEW</code> /{' '}
          <code>MATCH_FAILED</code>
        </li>
      </ul>

      <h2>实时可视化</h2>
      <ul>
        <li>
          Inngest UI — <a href="http://10.100.0.70:8288/stream" target="_blank">Stream</a> ·{' '}
          <a href="http://10.100.0.70:8288/functions" target="_blank">Functions</a>
        </li>
        <li>
          MinIO Console — <a href="http://10.100.0.70:9001" target="_blank">10.100.0.70:9001</a>
        </li>
      </ul>

      <h2>本地端点</h2>
      <ul>
        <li>
          <code>GET /api/inngest</code> — Inngest serve introspection
        </li>
        <li>
          <code>POST /api/inngest</code> — Inngest 调用 function
        </li>
        <li>
          <code>PUT /api/inngest</code> — Inngest 注册（远端 dev server PUT 这里）
        </li>
      </ul>

      <h2>常用命令</h2>
      <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, fontSize: 13 }}>
{`npm run register      # 让远端 Inngest dev server 注册到本机 :3020
npm run minio:list     # 列 MinIO 中可用简历 PDF
npm run minio:pick     # 随机选一份简历显示其 objectKey
npm run publish:test   # 手动发一条 RESUME_DOWNLOADED 触发完整流程`}
      </pre>

      <p style={{ color: '#888', marginTop: 32, fontSize: 12 }}>
        本页面独立于 agenticOperator 主仓 UI。设计文档：
        <code>docs/resume-agent-engineering-spec.md</code>
      </p>
    </main>
  );
}
