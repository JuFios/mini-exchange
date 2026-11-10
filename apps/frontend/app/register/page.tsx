import { AuthForm } from '../components/auth-form';

export const metadata = { title: 'Реєстрація · Mini Exchange' };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
