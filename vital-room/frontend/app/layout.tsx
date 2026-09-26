import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'バイタル共有ルーム',
  description: '同意にもとづく非接触バイタル(心拍・HRV・ストレス)の透明な共有',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* 見出し=Sora / 本文=Inter。読み込めない環境ではシステムフォントにフォールバック。 */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
