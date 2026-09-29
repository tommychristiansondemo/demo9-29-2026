import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <style jsx global>{`
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #f4f6fb;
          color: #1a2330;
        }
        a { color: #1d4ed8; }
      `}</style>
      <Component {...pageProps} />
    </>
  );
}
