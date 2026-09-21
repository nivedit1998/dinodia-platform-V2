import Link from 'next/link';

export default function AlexaConnectPage() {
  const skillUrl = process.env.ALEXA_SKILL_URL || 'https://www.amazon.co.uk/gp/product/B0GGCC4BDS?nodl=0';
  return (
    <main style={{ maxWidth: 640, margin: '12vh auto', padding: 32, fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ letterSpacing: 2, textTransform: 'uppercase', opacity: 0.6 }}>Dinodia Smart Living</p>
      <h1>Connect Alexa</h1>
      <p>Open the official Dinodia Smart Living skill in the Alexa app or browser, then sign in with your Dinodia account when Amazon asks.</p>
      <p><a href={skillUrl} target="_blank" rel="noreferrer">Open the official Alexa skill</a></p>
      <p style={{ opacity: 0.7 }}>This handoff expires shortly. No Amazon credentials are entered into Dinodia OS.</p>
      <Link href="/">Return to Dinodia</Link>
    </main>
  );
}
