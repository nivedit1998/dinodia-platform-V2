// Architecture: App Router surface src/app/alexa/oauth/authorize/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { AlexaAuthorizeForm } from './AlexaAuthorizeForm';

export default function AlexaAuthorizePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md bg-white shadow-lg rounded-2xl p-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-semibold">Link Dinodia to Alexa</h1>
          <p className="text-sm text-slate-500 mt-2">
            Sign in with your Dinodia account to connect Alexa to this home.
          </p>
        </div>

        <AlexaAuthorizeForm />
      </div>
    </div>
  );
}
