import { AuthShell } from '../components/auth/auth-shell';
import { SignInCard } from '../components/auth/sign-in-card';

export default function Home() {
  return (
    <AuthShell>
      <SignInCard />
    </AuthShell>
  );
}
