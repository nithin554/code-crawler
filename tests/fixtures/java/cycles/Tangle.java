package com.acme.cycles;

/**
 * Deliberately tangled call graph used to exercise cycle detection:
 * alpha -> beta -> gamma -> alpha is a 3-node cycle, and loop() calls itself.
 */
public class Tangle {
    public void alpha() {
        beta();
    }

    public void beta() {
        gamma();
    }

    public void gamma() {
        alpha();
    }

    public void loop() {
        loop();
    }

    public void entry() {
        alpha();
        loop();
    }
}
