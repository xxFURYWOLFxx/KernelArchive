import { LoadingState } from "@/components/loading-state";

export default function Loading() {
  return (
    <>
      <div className="ka-route-progress" role="progressbar"><span /></div>
      <div className="flex min-h-[55vh] items-center justify-center">
        <LoadingState className="w-full max-w-2xl" detail="Loading function details" label="Loading function" rows={4} />
      </div>
    </>
  );
}
