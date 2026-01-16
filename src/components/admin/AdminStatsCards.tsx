import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, Users, DollarSign, CreditCard, UserCheck, Clock } from "lucide-react";
import type { AdminStats } from "@/lib/admin";

interface AdminStatsCardsProps {
  stats: AdminStats;
}

export function AdminStatsCards({ stats }: AdminStatsCardsProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("nl-NL", {
      style: "currency",
      currency: "EUR",
    }).format(amount);
  };

  const cards = [
    {
      title: "Gross Volume (GMV)",
      value: formatCurrency(stats.overview.totalGMV),
      description: `${stats.overview.paidBookings} paid bookings`,
      icon: TrendingUp,
      color: "text-primary",
    },
    {
      title: "Platform Fees",
      value: formatCurrency(stats.overview.platformFees),
      description: `Avg ${stats.overview.avgFeePercent.toFixed(1)}% fee`,
      icon: DollarSign,
      color: "text-emerald-500",
    },
    {
      title: "Active Trainers",
      value: stats.overview.activeTrainers.toString(),
      description: `${stats.overview.connectedAccounts} connected to Stripe`,
      icon: UserCheck,
      color: "text-blue-500",
    },
    {
      title: "Active Players",
      value: stats.overview.activePlayers.toString(),
      description: `${stats.overview.totalBookings} total bookings`,
      icon: Users,
      color: "text-violet-500",
    },
    {
      title: "Stripe Connect",
      value: stats.overview.connectedAccounts.toString(),
      description: `${stats.overview.pendingAccounts} pending onboarding`,
      icon: CreditCard,
      color: "text-orange-500",
    },
    {
      title: "Stripe Balance",
      value: stats.stripeBalance?.available?.[0]
        ? formatCurrency(stats.stripeBalance.available[0].amount)
        : "€0.00",
      description: stats.stripeBalance?.pending?.[0]
        ? `${formatCurrency(stats.stripeBalance.pending[0].amount)} pending`
        : "No pending balance",
      icon: Clock,
      color: "text-amber-500",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className={`h-4 w-4 ${card.color}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{card.value}</div>
            <p className="text-xs text-muted-foreground">{card.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
