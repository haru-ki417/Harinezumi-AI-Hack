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
      <body>{children}</body>
    </html>
  );
}
