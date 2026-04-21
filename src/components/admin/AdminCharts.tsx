import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Area, AreaChart, Bar, BarChart, XAxis, YAxis, ResponsiveContainer, Pie, PieChart, Cell } from "recharts";
import { useTranslation } from "react-i18next";
import type { AdminStats } from "@/lib/admin";

interface AdminChartsProps {
  stats: AdminStats;
}

const tierColors = {
  starter: "hsl(var(--muted-foreground))",
  professional: "hsl(var(--primary))",
  academy: "hsl(var(--chart-4))",
};

export function AdminCharts({ stats }: AdminChartsProps) {
  const { t } = useTranslation("admin");

  const chartConfig = {
    gmv: {
      label: t("charts.legendGmv"),
      color: "hsl(var(--primary))",
    },
    fees: {
      label: t("charts.legendFees"),
      color: "hsl(var(--chart-2))",
    },
    bookings: {
      label: t("charts.legendBookings"),
      color: "hsl(var(--chart-3))",
    },
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("nl-NL", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const tierData = [
    { name: t("charts.tierStarter"), value: stats.trainersByTier.starter, color: tierColors.starter },
    { name: t("charts.tierProfessional"), value: stats.trainersByTier.professional, color: tierColors.professional },
    { name: t("charts.tierAcademy"), value: stats.trainersByTier.academy, color: tierColors.academy },
  ].filter(d => d.value > 0);

  const hasRevenue = stats.monthlyStats.some(m => m.gmv > 0);
  const hasTiers = tierData.length > 0;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Revenue Chart */}
      <Card className="col-span-2 md:col-span-1">
        <CardHeader>
          <CardTitle>{t("charts.revenueTitle")}</CardTitle>
          <CardDescription>{t("charts.revenueSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasRevenue ? (
            <ChartContainer config={chartConfig} className="h-[300px]">
              <AreaChart data={stats.monthlyStats} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <XAxis dataKey="month" />
                <YAxis tickFormatter={formatCurrency} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="gmv"
                  stackId="1"
                  stroke="var(--color-gmv)"
                  fill="var(--color-gmv)"
                  fillOpacity={0.3}
                  name={t("charts.legendGmv")}
                />
                <Area
                  type="monotone"
                  dataKey="fees"
                  stackId="2"
                  stroke="var(--color-fees)"
                  fill="var(--color-fees)"
                  fillOpacity={0.6}
                  name={t("charts.legendFees")}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <div className="flex h-[300px] items-center justify-center text-muted-foreground">
              {t("charts.noRevenue")}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bookings Chart */}
      <Card>
        <CardHeader>
          <CardTitle>{t("charts.bookingTitle")}</CardTitle>
          <CardDescription>{t("charts.bookingSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasRevenue ? (
            <ChartContainer config={chartConfig} className="h-[300px]">
              <BarChart data={stats.monthlyStats}>
                <XAxis dataKey="month" />
                <YAxis />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar
                  dataKey="bookings"
                  fill="var(--color-bookings)"
                  radius={[4, 4, 0, 0]}
                  name={t("charts.legendBookings")}
                />
              </BarChart>
            </ChartContainer>
          ) : (
            <div className="flex h-[300px] items-center justify-center text-muted-foreground">
              {t("charts.noBookings")}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trainer Tiers Pie Chart */}
      <Card>
        <CardHeader>
          <CardTitle>{t("charts.tiersTitle")}</CardTitle>
          <CardDescription>{t("charts.tiersSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasTiers ? (
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={tierData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                    labelLine={false}
                  >
                    {tierData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <ChartTooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-[300px] items-center justify-center text-muted-foreground">
              {t("charts.noTrainers")}
            </div>
          )}
          {hasTiers && (
            <div className="flex justify-center gap-4 mt-4">
              {tierData.map((tier) => (
                <div key={tier.name} className="flex items-center gap-2">
                  <div
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: tier.color }}
                  />
                  <span className="text-sm text-muted-foreground">
                    {tier.name} ({tier.value})
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
