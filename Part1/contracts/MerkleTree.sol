//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { PoseidonT3 } from "./Poseidon.sol"; //an existing library to perform Poseidon hash on solidity
import "./verifier.sol"; //inherits with the MerkleTreeInclusionProof verifier contract
import "hardhat/console.sol";

contract MerkleTree is Verifier {
    uint8 public depth; // the depth of the Merkle Tree
    uint256[] public hashes; // the Merkle tree in flattened array form
    uint256 public index = 0; // the current index of the first unfilled leaf
    uint256 public root; // the current Merkle root

    constructor(uint8 _depth) {
        depth = _depth;

        // Arrays are automatically initialized with 0's
        hashes = new uint256[](2 ** (depth + 1) - 1);

        // Calculate hash of non leaf nodes (can be ommitted if validating default zero leaf nodes is not necessary)
        uint start = 0; // starting index of each level
        for (uint level = depth; level > 0; level--) { // loop through each level
            uint next_start = start + 2 ** level; // starting index of next level (where to store the result)
            for (uint current = 0; current < 2 ** level; current += 2) // loop through each pair in current level
                hashes[next_start + current/2] = PoseidonT3.poseidon([hashes[start+current], hashes[start+current+1]]);
            start = next_start;
        }
    }

    function printTree() private view {
        console.log("next index = %d", index);
        for (uint i = 0; i < 2**(depth+1)-1; i++)
            console.log("hashes[%d] = %d", i, hashes[i]);
    }

    function insertLeaf(uint256 hashedLeaf) public returns (uint256) {
        require(index < 2 ** depth, "Tree is full, can't insert more nodes.");

        uint start = 0; // starting index of each level
        uint current = index; // index of current node within the level
        uint256 hash_result;

        hashes[index++] = hashedLeaf;
        for (uint level = depth; level > 0; level--) {
            uint i = start + current;
            if (i % 2 == 1) 
                hash_result = PoseidonT3.poseidon([hashes[i-1], hashes[i]]);
            else 
                hash_result = PoseidonT3.poseidon([hashes[i], hashes[i+1]]);
            
            // adjust start and current index for next level
            start += 2 ** level;
            current /= 2;

            // store calculated hash value in parent level
            hashes[start + current] = hash_result;
        }

        return hash_result;
    }

    function verify(
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[1] memory input
        ) public view returns (bool) {

        // Ensure the root calculated by the proof matches the actual root 
        // This is done first for optimization (so that proof does not need to be verified if roots do not match)
        if (input[0] != hashes[2**(depth+1)-2])
            return false;

        // Return whether the proof is valid
        return verifyProof(a, b, c, input);
    }
}
