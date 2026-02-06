import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { isUserAdmin } from '@/lib/admin';
import {
  Certification,
  Specialization,
  getAllCertifications,
  getAllSpecializations,
  createCertification,
  updateCertification,
  deleteCertification,
  createSpecialization,
  updateSpecialization,
  deleteSpecialization,
  getCountryInfo,
  COUNTRIES,
} from '@/lib/certifications';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft,
  Plus,
  Edit,
  Trash2,
  Loader2,
  ShieldAlert,
  Award,
  Target,
} from 'lucide-react';
import { logger } from '@/lib/logger';

export default function AdminCertifications() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  
  const [certifications, setCertifications] = useState<Certification[]>([]);
  const [specializations, setSpecializations] = useState<Specialization[]>([]);
  
  // Dialog states
  const [certDialogOpen, setCertDialogOpen] = useState(false);
  const [specDialogOpen, setSpecDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  
  // Edit states
  const [editingCert, setEditingCert] = useState<Certification | null>(null);
  const [editingSpec, setEditingSpec] = useState<Specialization | null>(null);
  const [deletingItem, setDeletingItem] = useState<{ type: 'cert' | 'spec'; id: string; name: string } | null>(null);
  
  // Form states
  const [certForm, setCertForm] = useState({ name: '', country: 'NL', description: '' });
  const [specForm, setSpecForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/app/auth');
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    async function checkAdminAndFetch() {
      if (!user) return;
      
      const adminStatus = await isUserAdmin(user.id);
      setIsAdmin(adminStatus);
      
      if (!adminStatus) {
        setLoading(false);
        return;
      }
      
      await fetchData();
      setLoading(false);
    }
    
    if (user) {
      checkAdminAndFetch();
    }
  }, [user]);

  const fetchData = async () => {
    const [certs, specs] = await Promise.all([
      getAllCertifications(),
      getAllSpecializations(),
    ]);
    setCertifications(certs);
    setSpecializations(specs);
  };

  // Group certifications by country
  const certificationsByCountry = certifications.reduce((acc, cert) => {
    if (!acc[cert.country]) acc[cert.country] = [];
    acc[cert.country].push(cert);
    return acc;
  }, {} as Record<string, Certification[]>);

  // Certification handlers
  const openCertDialog = (cert?: Certification) => {
    if (cert) {
      setEditingCert(cert);
      setCertForm({ name: cert.name, country: cert.country, description: cert.description || '' });
    } else {
      setEditingCert(null);
      setCertForm({ name: '', country: 'NL', description: '' });
    }
    setCertDialogOpen(true);
  };

  const handleSaveCert = async () => {
    if (!certForm.name.trim()) return;
    
    setSaving(true);
    try {
      if (editingCert) {
        await updateCertification(editingCert.id, {
          name: certForm.name,
          country: certForm.country,
          description: certForm.description || null,
        });
        toast({ title: 'Certification updated' });
      } else {
        await createCertification(certForm.name, certForm.country, certForm.description || undefined);
        toast({ title: 'Certification created' });
      }
      await fetchData();
      setCertDialogOpen(false);
    } catch (error: any) {
      logger.error('Error saving certification', error as Error, { component: 'AdminCertifications', certId: editingCert?.id });
      toast({
        title: 'Error',
        description: error.message || 'Failed to save certification',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleCertActive = async (cert: Certification) => {
    try {
      await updateCertification(cert.id, { is_active: !cert.is_active });
      await fetchData();
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to update status', variant: 'destructive' });
    }
  };

  // Specialization handlers
  const openSpecDialog = (spec?: Specialization) => {
    if (spec) {
      setEditingSpec(spec);
      setSpecForm({ name: spec.name, description: spec.description || '' });
    } else {
      setEditingSpec(null);
      setSpecForm({ name: '', description: '' });
    }
    setSpecDialogOpen(true);
  };

  const handleSaveSpec = async () => {
    if (!specForm.name.trim()) return;
    
    setSaving(true);
    try {
      if (editingSpec) {
        await updateSpecialization(editingSpec.id, {
          name: specForm.name,
          description: specForm.description || null,
        });
        toast({ title: 'Specialization updated' });
      } else {
        await createSpecialization(specForm.name, specForm.description || undefined);
        toast({ title: 'Specialization created' });
      }
      await fetchData();
      setSpecDialogOpen(false);
    } catch (error: any) {
      logger.error('Error saving specialization', error as Error, { component: 'AdminCertifications', specId: editingSpec?.id });
      toast({
        title: 'Error',
        description: error.message || 'Failed to save specialization',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSpecActive = async (spec: Specialization) => {
    try {
      await updateSpecialization(spec.id, { is_active: !spec.is_active });
      await fetchData();
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to update status', variant: 'destructive' });
    }
  };

  // Delete handlers
  const openDeleteDialog = (type: 'cert' | 'spec', id: string, name: string) => {
    setDeletingItem({ type, id, name });
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingItem) return;
    
    try {
      if (deletingItem.type === 'cert') {
        await deleteCertification(deletingItem.id);
      } else {
        await deleteSpecialization(deletingItem.id);
      }
      toast({ title: `${deletingItem.type === 'cert' ? 'Certification' : 'Specialization'} deleted` });
      await fetchData();
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to delete', variant: 'destructive' });
    } finally {
      setDeleteDialogOpen(false);
      setDeletingItem(null);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <ShieldAlert className="h-16 w-16 text-destructive" />
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground">You don't have admin privileges.</p>
        <Button onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center gap-4 px-4 py-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/admin')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Certifications & Specializations</h1>
            <p className="text-sm text-muted-foreground">Manage trainer qualification options</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="certifications">
          <TabsList className="mb-6">
            <TabsTrigger value="certifications" className="gap-2">
              <Award className="h-4 w-4" />
              Certifications
            </TabsTrigger>
            <TabsTrigger value="specializations" className="gap-2">
              <Target className="h-4 w-4" />
              Specializations
            </TabsTrigger>
          </TabsList>

          {/* Certifications Tab */}
          <TabsContent value="certifications" className="space-y-6">
            <div className="flex justify-between items-center">
              <p className="text-muted-foreground">
                {certifications.length} certifications across {Object.keys(certificationsByCountry).length} countries
              </p>
              <Button onClick={() => openCertDialog()}>
                <Plus className="h-4 w-4 mr-2" />
                Add Certification
              </Button>
            </div>

            {Object.entries(certificationsByCountry)
              .sort(([a], [b]) => {
                if (a === 'INT') return 1;
                if (b === 'INT') return -1;
                return getCountryInfo(a).name.localeCompare(getCountryInfo(b).name);
              })
              .map(([country, certs]) => {
                const countryInfo = getCountryInfo(country);
                return (
                  <Card key={country}>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <span>{countryInfo.flag}</span>
                        {countryInfo.name}
                        <Badge variant="secondary">{certs.length}</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {certs
                          .sort((a, b) => a.display_order - b.display_order)
                          .map(cert => (
                            <div
                              key={cert.id}
                              className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                            >
                              <div className="flex items-center gap-3">
                                <Switch
                                  checked={cert.is_active}
                                  onCheckedChange={() => handleToggleCertActive(cert)}
                                />
                                <div>
                                  <span className={!cert.is_active ? 'text-muted-foreground line-through' : ''}>
                                    {cert.name}
                                  </span>
                                  {cert.description && (
                                    <p className="text-xs text-muted-foreground">{cert.description}</p>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openCertDialog(cert)}
                                >
                                  <Edit className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => openDeleteDialog('cert', cert.id, cert.name)}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            </div>
                          ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
          </TabsContent>

          {/* Specializations Tab */}
          <TabsContent value="specializations" className="space-y-6">
            <div className="flex justify-between items-center">
              <p className="text-muted-foreground">
                {specializations.length} specializations
              </p>
              <Button onClick={() => openSpecDialog()}>
                <Plus className="h-4 w-4 mr-2" />
                Add Specialization
              </Button>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>All Specializations</CardTitle>
                <CardDescription>Universal training focus areas available to all trainers</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {specializations
                    .sort((a, b) => a.display_order - b.display_order)
                    .map(spec => (
                      <div
                        key={spec.id}
                        className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                      >
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={spec.is_active}
                            onCheckedChange={() => handleToggleSpecActive(spec)}
                          />
                          <div>
                            <span className={!spec.is_active ? 'text-muted-foreground line-through' : ''}>
                              {spec.name}
                            </span>
                            {spec.description && (
                              <p className="text-xs text-muted-foreground">{spec.description}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openSpecDialog(spec)}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openDeleteDialog('spec', spec.id, spec.name)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Certification Dialog */}
      <Dialog open={certDialogOpen} onOpenChange={setCertDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingCert ? 'Edit Certification' : 'Add Certification'}
            </DialogTitle>
            <DialogDescription>
              Add a certification that trainers can select for their profile.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="cert-name">Name</Label>
              <Input
                id="cert-name"
                value={certForm.name}
                onChange={e => setCertForm({ ...certForm, name: e.target.value })}
                placeholder="e.g., KNLTB Level 3"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cert-country">Country</Label>
              <Select
                value={certForm.country}
                onValueChange={value => setCertForm({ ...certForm, country: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(COUNTRIES).map(([code, info]) => (
                    <SelectItem key={code} value={code}>
                      {info.flag} {info.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cert-desc">Description (optional)</Label>
              <Input
                id="cert-desc"
                value={certForm.description}
                onChange={e => setCertForm({ ...certForm, description: e.target.value })}
                placeholder="Brief description..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCertDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveCert} disabled={saving || !certForm.name.trim()}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Specialization Dialog */}
      <Dialog open={specDialogOpen} onOpenChange={setSpecDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingSpec ? 'Edit Specialization' : 'Add Specialization'}
            </DialogTitle>
            <DialogDescription>
              Add a specialization that trainers can select for their profile.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="spec-name">Name</Label>
              <Input
                id="spec-name"
                value={specForm.name}
                onChange={e => setSpecForm({ ...specForm, name: e.target.value })}
                placeholder="e.g., Competition Preparation"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="spec-desc">Description (optional)</Label>
              <Input
                id="spec-desc"
                value={specForm.description}
                onChange={e => setSpecForm({ ...specForm, description: e.target.value })}
                placeholder="Brief description..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpecDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveSpec} disabled={saving || !specForm.name.trim()}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deletingItem?.type === 'cert' ? 'Certification' : 'Specialization'}?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deletingItem?.name}"? This action cannot be undone.
              Trainers who have this selected will keep it until they update their profile.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
