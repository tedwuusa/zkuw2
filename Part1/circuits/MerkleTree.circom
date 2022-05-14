pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

template CheckRoot(n) { // compute the root of a MerkleTree of n Levels 
    signal input leaves[2**n];
    signal output root;

    component nodes[2**n];

    // Sample layout for n=3
    //
    //   level     start index              node index
    //     1         2**0 = 1                   1 (root)
    //     2         2**1 = 2             2           3
    //     n         2**2 = 4          4     5     6     7
    //  leaves[]                      0 1   2 3   4 5   6 7

    for (var level = n; level > 0; level--) { 
        var start = 2 ** (level - 1); 
        for (var i = 0; i < start; i++) {
            var index = start + i;
            nodes[index] = Poseidon(2);
            if (level == n) {
                nodes[index].inputs[0] <== leaves[i * 2];
                nodes[index].inputs[1] <== leaves[i * 2 + 1];
            }
            else {
                nodes[index].inputs[0] <== nodes[index * 2].out;
                nodes[index].inputs[1] <== nodes[index * 2 + 1].out;
            }
        }
    }

    root <== nodes[1].out;
}

template MerkleTreeInclusionProof(n) {
    signal input leaf;
    signal input path_elements[n]; // higher index is closer to root
    signal input path_index[n]; // path index are 0's and 1's indicating whether the current element is on the left or right
    signal output root; // note that this is an OUTPUT signal

    // Sample layout for n=3 and 6th leaf
    //
    //  path_index               path_elements, nodes
    //                                 n[2]
    //  p_i[2] = 1          p_e[2]              n[1]
    //  p_i[1] = 0         X     X         n[0]     p_e[1]
    //  p_i[0] = 1        X X   X X   p_e[0] leaf   X   X

    // component to calculate hashes
    component nodes[n];

    for (var i = 0; i < n; i++) {
        path_index[i] * (1 - path_index[i]) === 0; // ensure path index input is boolean

        nodes[i] = Poseidon(2);
        var current = (i == 0) ? leaf : nodes[i-1].out;
        nodes[i].inputs[0] <== current + (path_elements[i] - current) * path_index[i];
        nodes[i].inputs[1] <== path_elements[i] + (current - path_elements[i]) * path_index[i];
    }

    root <== nodes[n-1].out;
}