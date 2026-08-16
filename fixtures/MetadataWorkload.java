import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * Workload for the metadata fixture: burns CPU (so execution samples exist)
 * while churning allocations (so the GC runs and emits heap summaries and
 * collection events). Recorded with metadata-profile.jfc.
 */
public class MetadataWorkload {
    private static final Random RANDOM = new Random(42);
    private static volatile long sink;

    public static void main(String[] args) throws Exception {
        long durationMs = args.length > 0 ? Long.parseLong(args[0]) : 3000;
        long deadline = System.currentTimeMillis() + durationMs;
        List<byte[]> retained = new ArrayList<>();
        while (System.currentTimeMillis() < deadline) {
            sink += burn(20_000);
            // Allocation churn: mostly garbage, a sliding window retained so
            // the heap level visibly moves between collections.
            retained.add(new byte[64 * 1024]);
            if (retained.size() > 256) {
                retained.subList(0, 128).clear();
            }
        }
        System.gc();
        System.out.println("sink=" + sink + " retained=" + retained.size());
    }

    private static long burn(int iterations) {
        long acc = 0;
        for (int i = 0; i < iterations; i++) {
            acc += RANDOM.nextInt(1000);
        }
        return acc;
    }
}
