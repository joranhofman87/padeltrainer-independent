import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { 
  ArrowLeft, 
  DollarSign, 
  TrendingUp, 
  Calendar, 
  CreditCard,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  Wallet,
  Building2,
  AlertCircle,
  CheckCircle2,
  ExternalLink
} from 'lucide-react';

interface Transaction {
  id: string;
  type: 'payout' | 'earning';
  description: string;
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  date: string;
}

// Mock data for UI demonstration
const mockTransactions: Transaction[] = [
  { id: '1', type: 'earning', description: 'Beginner Padel Training - John D.', amount: 45, status: 'completed', date: '2024-01-15' },
  { id: '2', type: 'earning', description: 'Advanced Techniques - Sarah M.', amount: 65, status: 'completed', date: '2024-01-14' },
  { id: '3', type: 'payout', description: 'Weekly payout to bank', amount: 280, status: 'completed', date: '2024-01-12' },
  { id: '4', type: 'earning', description: 'Group Session (4 players)', amount: 120, status: 'pending', date: '2024-01-16' },
  { id: '5', type: 'earning', description: 'Private Coaching - Mike K.', amount: 55, status: 'completed', date: '2024-01-13' },
];

export default function TrainerEarnings() {
  const navigate = useNavigate();
  const { user, role, loading } = useAuth();
  const [stripeConnected, setStripeConnected] = useState(false);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const availableBalance = 285;
  const pendingBalance = 120;
  const totalEarnings = 1450;
  const thisMonth = 405;

  const handleConnectStripe = () => {
    // In real implementation, this would redirect to Stripe Connect onboarding
    setStripeConnected(true);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="flex items-center gap-3">
                <span className="text-2xl">💰</span>
                <span className="font-bold text-xl">Earnings & Payouts</span>
              </div>
            </div>
            {stripeConnected && (
              <Button variant="outline" size="sm" className="gap-2">
                <ExternalLink className="h-4 w-4" />
                Stripe Dashboard
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Stripe Connect Banner */}
        {!stripeConnected && (
          <Card className="mb-8 border-orange-200 dark:border-orange-800 bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-950/50 dark:to-amber-950/50">
            <CardContent className="p-6">
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-full bg-orange-100 dark:bg-orange-900">
                    <CreditCard className="h-6 w-6 text-orange-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg mb-1">Set up payouts with Stripe Connect</h3>
                    <p className="text-muted-foreground">
                      Connect your bank account to receive payouts directly. Secure, fast, and automatic.
                    </p>
                  </div>
                </div>
                <Button onClick={handleConnectStripe} className="gap-2 shrink-0">
                  <Building2 className="h-4 w-4" />
                  Connect Bank Account
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Balance Cards */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-muted-foreground">Available Balance</p>
                <Wallet className="h-4 w-4 text-green-600" />
              </div>
              <p className="text-3xl font-bold text-green-600">€{availableBalance}</p>
              <p className="text-xs text-muted-foreground mt-1">Ready for payout</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-muted-foreground">Pending</p>
                <Clock className="h-4 w-4 text-orange-500" />
              </div>
              <p className="text-3xl font-bold text-orange-500">€{pendingBalance}</p>
              <p className="text-xs text-muted-foreground mt-1">Awaiting confirmation</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-muted-foreground">This Month</p>
                <TrendingUp className="h-4 w-4 text-blue-500" />
              </div>
              <p className="text-3xl font-bold">€{thisMonth}</p>
              <div className="flex items-center gap-1 mt-1">
                <ArrowUpRight className="h-3 w-3 text-green-500" />
                <span className="text-xs text-green-600">+23% vs last month</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm text-muted-foreground">Total Earnings</p>
                <DollarSign className="h-4 w-4 text-primary" />
              </div>
              <p className="text-3xl font-bold">€{totalEarnings}</p>
              <p className="text-xs text-muted-foreground mt-1">All time</p>
            </CardContent>
          </Card>
        </div>

        {/* Payout Button */}
        {stripeConnected && availableBalance > 0 && (
          <Card className="mb-8">
            <CardContent className="p-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-lg">Request Payout</h3>
                  <p className="text-sm text-muted-foreground">
                    Transfer €{availableBalance} to your connected bank account
                  </p>
                </div>
                <Button className="gap-2">
                  <ArrowUpRight className="h-4 w-4" />
                  Request Payout
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Transactions */}
        <Card>
          <CardHeader>
            <CardTitle>Transaction History</CardTitle>
            <CardDescription>View all your earnings and payouts</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="all">
              <TabsList className="mb-4">
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="earnings">Earnings</TabsTrigger>
                <TabsTrigger value="payouts">Payouts</TabsTrigger>
              </TabsList>

              <TabsContent value="all" className="space-y-0">
                <div className="divide-y">
                  {mockTransactions.map((transaction) => (
                    <TransactionRow key={transaction.id} transaction={transaction} />
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="earnings" className="space-y-0">
                <div className="divide-y">
                  {mockTransactions
                    .filter(t => t.type === 'earning')
                    .map((transaction) => (
                      <TransactionRow key={transaction.id} transaction={transaction} />
                    ))}
                </div>
              </TabsContent>

              <TabsContent value="payouts" className="space-y-0">
                <div className="divide-y">
                  {mockTransactions
                    .filter(t => t.type === 'payout')
                    .map((transaction) => (
                      <TransactionRow key={transaction.id} transaction={transaction} />
                    ))}
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"><CheckCircle2 className="h-3 w-3 mr-1" />Completed</Badge>;
      case 'pending':
        return <Badge variant="secondary" className="bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
      case 'failed':
        return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />Failed</Badge>;
      default:
        return null;
    }
  };

  return (
    <div className="flex items-center justify-between py-4">
      <div className="flex items-center gap-4">
        <div className={`p-2 rounded-full ${transaction.type === 'earning' ? 'bg-green-100 dark:bg-green-900' : 'bg-blue-100 dark:bg-blue-900'}`}>
          {transaction.type === 'earning' ? (
            <ArrowDownRight className="h-4 w-4 text-green-600 dark:text-green-400" />
          ) : (
            <ArrowUpRight className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          )}
        </div>
        <div>
          <p className="font-medium">{transaction.description}</p>
          <p className="text-sm text-muted-foreground">
            {new Date(transaction.date).toLocaleDateString('nl-NL', { 
              day: 'numeric', 
              month: 'short', 
              year: 'numeric' 
            })}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4">
        {getStatusBadge(transaction.status)}
        <span className={`font-semibold tabular-nums ${transaction.type === 'earning' ? 'text-green-600' : 'text-foreground'}`}>
          {transaction.type === 'earning' ? '+' : '-'}€{transaction.amount}
        </span>
      </div>
    </div>
  );
}