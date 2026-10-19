import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.Pipe;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.ServerSocketChannel;

/** Preflight the local IPC used by Gradle before starting an Android build. */
public class JavaSelectorProbe {
    public static void main(String[] args) throws Exception {
        try (Selector selector = Selector.open();
             ServerSocketChannel server = ServerSocketChannel.open()) {
            Pipe pipe = Pipe.open();
            try (var source = pipe.source(); var sink = pipe.sink()) {
                sink.write(ByteBuffer.wrap(new byte[] {1, 2, 3, 4}));
                ByteBuffer received = ByteBuffer.allocate(4);
                if (source.read(received) != 4) throw new IllegalStateException("Pipe read mismatch");
            }
            server.configureBlocking(false);
            server.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
            server.register(selector, SelectionKey.OP_ACCEPT);
            selector.selectNow();
        }
        System.out.println("PASS Java Selector, Pipe read/write, loopback channel registration");
    }
}
