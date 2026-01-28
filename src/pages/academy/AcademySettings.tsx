import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyManagers } from '@/lib/academy';
import { useState, useEffect } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';

export default function AcademySettings() {
  const { t } = useTranslation('academy');
  const { activeAcademy } = useAcademyContext();
  const [managers, setManagers] = useState<any[]>([]);

  useEffect(() => {
    async function fetchManagers() {
      if (!activeAcademy) return;
      const data = await getAcademyManagers(activeAcademy.id);
      setManagers(data);
    }
    fetchManagers();
  }, [activeAcademy]);

  if (!activeAcademy) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <div className="space-y-6">
        {/* Managers */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              {t('managers.title')}
            </CardTitle>
            <CardDescription>{t('managers.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {managers.map((manager) => (
                <div key={manager.id} className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarImage src={manager.profile?.avatar_url} />
                      <AvatarFallback>
                        {manager.profile?.full_name?.charAt(0) || 'U'}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{manager.profile?.full_name || t('common:unknown')}</p>
                      <p className="text-sm text-muted-foreground">{manager.profile?.email}</p>
                    </div>
                  </div>
                  <Badge variant={manager.role === 'owner' ? 'default' : 'secondary'}>
                    {manager.role === 'owner' ? t('managers.owner') : t('managers.manager')}
                  </Badge>
                </div>
              ))}
              
              {managers.length === 0 && (
                <p className="text-center text-muted-foreground py-4">
                  {t('managers.noManagers', 'No managers found')}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
