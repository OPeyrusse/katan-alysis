import java.util.Random;

/**
 * Small CPU-bound workload with a recognizable call shape, used to record the
 * test fixture JFR. Two entry points (pathA / pathB) both funnel into the same
 * hot coordinator method, which is exactly the "diluted bottleneck" scenario
 * the merged callers/callees view is designed for.
 */
public class FixtureWorkload {
    private static final Random RANDOM = new Random(42);
    private static volatile long sink;

    public static void main(String[] args) throws Exception {
        long durationMs = args.length > 0 ? Long.parseLong(args[0]) : 3000;
        Thread worker = new Thread(() -> runWorker(durationMs), "fixture-worker");
        worker.start();
        long deadline = System.currentTimeMillis() + durationMs;
        while (System.currentTimeMillis() < deadline) {
            sink += pathA();
            sink += pathB();
        }
        worker.join();
        System.out.println("sink=" + sink);
    }

    private static void runWorker(long durationMs) {
        long deadline = System.currentTimeMillis() + durationMs;
        while (System.currentTimeMillis() < deadline) {
            sink += hotCoordinator();
        }
    }

    private static long pathA() {
        return hotCoordinator() + cheapWork(1_000);
    }

    private static long pathB() {
        return hotCoordinator() + cheapWork(2_000);
    }

    private static long hotCoordinator() {
        return expensiveLeaf(30_000) + cheapWork(5_000);
    }

    private static long expensiveLeaf(int iterations) {
        long acc = 0;
        for (int i = 0; i < iterations; i++) {
            acc += RANDOM.nextInt(1000);
        }
        return acc;
    }

    private static long cheapWork(int iterations) {
        long acc = 0;
        for (int i = 0; i < iterations; i++) {
            acc += i * 31L;
        }
        return acc;
    }
}
