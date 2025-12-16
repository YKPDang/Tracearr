import { Outlet } from 'react-router';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AppSidebar } from './AppSidebar';
import { Header } from './Header';

export function Layout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Header />
        <ScrollArea className="flex-1">
          <main className="p-6">
            <Outlet />
          </main>
        </ScrollArea>
      </SidebarInset>
    </SidebarProvider>
  );
}
