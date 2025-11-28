import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Activity,
  Users,
  Shield,
  AlertTriangle,
  Settings,
  Map,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/brand/Logo';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Activity', href: '/activity', icon: Activity },
  { name: 'Users', href: '/users', icon: Users },
  { name: 'Map', href: '/map', icon: Map },
  { name: 'Rules', href: '/rules', icon: Shield },
  { name: 'Violations', href: '/violations', icon: AlertTriangle },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="flex w-64 flex-col border-r bg-card">
      <div className="flex h-16 items-center border-b px-6">
        <Logo size="md" />
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {navigation.map((item) => (
          <NavLink
            key={item.name}
            to={item.href}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )
            }
          >
            <item.icon className="h-5 w-5" />
            {item.name}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
