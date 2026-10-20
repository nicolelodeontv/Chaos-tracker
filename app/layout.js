export const metadata = { title: 'Clan Tracker' };
export default function Layout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#0f1115', color: '#e6e6e6' }}>
        {children}
      </body>
    </html>
  );
}
