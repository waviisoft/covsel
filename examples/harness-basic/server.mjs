import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8934);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (url.pathname === '/add') {
    const { add } = await import('./src/add.mjs');
    res.writeHead(200).end(String(add(3, 4)));
    return;
  }
  if (url.pathname === '/sub') {
    const { sub } = await import('./src/sub.mjs');
    res.writeHead(200).end(String(sub(3, 2)));
    return;
  }
  if (url.pathname === '/mul') {
    const { mul } = await import('./src/mul.mjs');
    res.writeHead(200).end(String(mul(3, 4)));
    return;
  }
  res.writeHead(404).end('');
}).listen(port, '127.0.0.1');
