/** Aggregate view: build duration over time, daily outcomes, flaky tests. */

import { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";

import type { rpcContract } from "../src/contract";
import { formatDuration } from "./format";
import { EmptyState } from "./primitives";

interface TrendsData {
  durations: Array<{
    at: number;
    durationMs: number;
    status: string;
    scheme: string | null;
    kind: string;
  }>;
  daily: Array<{
    day: string;
    total: number;
    failed: number;
    passed: number;
    avgDurationMs: number | null;
  }>;
  flakyTests: Array<{
    name: string;
    suite: string | null;
    failures: number;
    runs: number;
  }>;
}

const durationConfig = {
  durationMs: { label: "Duration", color: "var(--chart-1)" },
} satisfies ChartConfig;

const outcomeConfig = {
  passed: { label: "Passed", color: "var(--chart-2)" },
  failed: { label: "Failed", color: "var(--chart-5)" },
} satisfies ChartConfig;

export function Trends({ projectId }: { projectId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void rpc
      .call("trends", { projectId, days: 30 })
      .then((result) => setData(result as TrendsData))
      .finally(() => setLoading(false));
  }, [rpc, projectId]);

  if (loading && !data) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.durations.length === 0) {
    return (
      <EmptyState
        icon="ChartColumn"
        title="Not enough history yet"
        description="Trends appear once a few builds have been recorded. Keep building — the tracker collects automatically."
      />
    );
  }

  const durationSeries = data.durations.map((entry) => ({
    at: entry.at,
    durationMs: entry.durationMs,
    label: new Date(entry.at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Build duration</CardTitle>
            <CardDescription>
              Every recorded run over the last 30 days
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={durationConfig} className="h-56 w-full">
              <LineChart data={durationSeries} margin={{ left: 4, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  tickFormatter={(value: number) => formatDuration(value)}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => formatDuration(Number(value))}
                    />
                  }
                />
                <Line
                  dataKey="durationMs"
                  type="monotone"
                  stroke="var(--color-durationMs)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Daily outcomes</CardTitle>
            <CardDescription>Passed versus failed per day</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={outcomeConfig} className="h-56 w-full">
              <BarChart data={data.daily} margin={{ left: 4, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  tickFormatter={(value: string) => value.slice(5)}
                />
                <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar
                  dataKey="passed"
                  stackId="a"
                  fill="var(--color-passed)"
                  radius={[0, 0, 2, 2]}
                />
                <Bar
                  dataKey="failed"
                  stackId="a"
                  fill="var(--color-failed)"
                  radius={[2, 2, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Flaky tests</CardTitle>
          <CardDescription>
            Tests that have both passed and failed in the last 30 days
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.flakyTests.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No test has both passed and failed yet.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {data.flakyTests.map((test) => (
                <div
                  key={`${test.suite ?? ""}/${test.name}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm">
                    {test.suite ? (
                      <span className="text-muted-foreground">{test.suite}/</span>
                    ) : null}
                    {test.name}
                  </span>
                  <Badge variant="secondary" className="shrink-0 tabular-nums">
                    {test.failures}/{test.runs} failed
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
