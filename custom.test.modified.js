const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, registerAndTransact, prepareTransaction, buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

describe('Custom Tests', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    return { tornadoPool, token, proxy, omniBridge, amb, gov, multisig }
  }

  it('[assignment] ii. deposit 0.1 ETH in L1 -> withdraw 0.08 ETH in L2 -> assert balances', async () => {
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)
    const aliceKeypair = new Keypair() 

    // 1. Alice deposits 0.1 ETH in L1
    // --------------------------------

    // Create transaction
    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })

    // Prepare data for transaction that will be executed remotely
    const { args, extData } = await prepareTransaction({ tornadoPool, outputs: [aliceDepositUtxo] })
    const onTokenBridgedData = encodeDataForBridge({ proof: args, extData })
    const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      aliceDepositUtxo.amount,
      onTokenBridgedData,
    )

    // Emulating bridge. first it sends tokens to omnibridge mock then it sends to the pool
    await token.transfer(omniBridge.address, aliceDepositAmount)
    const transferTx = await token.populateTransaction.transfer(tornadoPool.address, aliceDepositAmount)

    // Execute bridged transactions
    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, // send tokens to pool
      { who: tornadoPool.address, callData: onTokenBridgedTx.data }, // call onTokenBridgedTx
    ])

    // 2. Alice withdraws 0.08 ETH in L2
    // ---------------------------------

    const aliceWithdrawAmount = utils.parseEther('0.08')
    // recipient address does not have to be sender's (Alice's) address
    // since we have all secrets (private key and blinding) and zkp will generate proof for that
    const recipient = '0x1234567800000000000000000000000000000000' 
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(aliceWithdrawAmount),
      keypair: aliceKeypair,
    })
    await transaction({
      tornadoPool,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: recipient,
    })

    // 3. Check balances
    // ---------------------------------

    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance).to.be.equal(utils.parseEther('0.08'))

    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(0)

    const poolBalance = await token.balanceOf(tornadoPool.address)
    expect(poolBalance).to.be.equal(utils.parseEther('0.02'))    
  })

  it('[assignment] iii. deposit 0.13 in L1 -> send 0.06 in L2 -> withdraw all -> assert balances', async () => {
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)

    // 1. Alice deposits 0.13 ETH in L1
    // --------------------------------

    // Create transaction
    const aliceKeypair = new Keypair() 
    const aliceDepositAmount = utils.parseEther('0.13')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })

    // Prepare data for transaction that will be executed remotely
    const { args, extData } = await prepareTransaction({ tornadoPool, outputs: [aliceDepositUtxo] })
    const onTokenBridgedData = encodeDataForBridge({ proof: args, extData })
    const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      aliceDepositUtxo.amount,
      onTokenBridgedData,
    )

    // Emulating bridge. first it sends tokens to omnibridge mock then it sends to the pool
    await token.transfer(omniBridge.address, aliceDepositAmount)
    const transferTx = await token.populateTransaction.transfer(tornadoPool.address, aliceDepositAmount)

    // Execute bridged transactions
    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, // send tokens to pool
      { who: tornadoPool.address, callData: onTokenBridgedTx.data }, // call onTokenBridgedTx
    ])

    // 2. Alice sends Bob 0.06 ETH in L2
    // ---------------------------------

    // Bob gives Alice address to send some eth inside the shielded pool
    const bobKeypair = new Keypair() // contains private and public keys
    const bobAddress = bobKeypair.address() // contains only public key

    // Create two transactions, one to transfer to Bob, one represent the remaining balance
    const bobSendAmount = utils.parseEther('0.06')
    const bobSendUtxo = new Utxo({ amount: bobSendAmount, keypair: Keypair.fromString(bobAddress) })
    const aliceChangeUtxo = new Utxo({ amount: aliceDepositAmount.sub(bobSendAmount), keypair: aliceDepositUtxo.keypair })

    // Execute the transactions. The original aliceDepositUtxo will be "spent" and can not be used again
    // Two new commitments for the output transactions will be added to the tree, and can be spent in the future
    // Since the two output transaction amounts add up to the exact amount of the input, no actual token transfer happens
    await transaction({ tornadoPool, inputs: [aliceDepositUtxo], outputs: [bobSendUtxo, aliceChangeUtxo] })

    // 3. Bob withdraws all funds in L2
    const bobBalanceUtxo = new Utxo({
      amount: bobSendAmount,
      keypair: bobKeypair, // The receiving bobSendUtxo can not be reused here since private key is required for spending
      blinding: bobSendUtxo.blinding, // Need to use the same blinding value as it is part of the commitment
    })
    const bobRecipient = '0xabcdef0000000000000000000000000000000000'
    await transaction({
      tornadoPool,
      inputs: [bobBalanceUtxo],
      recipient: bobRecipient,
    })

    // 4. Alice withdraws all funds in L1
    const aliceRecipient = '0x1234560000000000000000000000000000000000'
    await transaction({
      tornadoPool,
      inputs: [aliceChangeUtxo],  // Original Utxo can be used here since it already contain private key and proper blinding value
      recipient: aliceRecipient,
      isL1Withdrawal: true,
    })

    // 5. Check balances
    // -----------------

    // Bob receives all funds in his account in L2
    const bobRecipientBalance = await token.balanceOf(bobRecipient)
    expect(bobRecipientBalance).to.be.equal(utils.parseEther('0.06'))

    // Alice withdrew in L1, but the mocked bridge does not have logic to transfer funds into Alice's account
    const aliceRecipientBalance = await token.balanceOf(aliceRecipient)
    expect(aliceRecipientBalance).to.be.equal(0)

    // So the fund Alice withdrew is sitting in in bridge account in L1 (in testing setup L1 and L2 are on same chain) 
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(utils.parseEther('0.07'))

    // The pool should be empty since everything is withdrawn
    const poolBalance = await token.balanceOf(tornadoPool.address)
    expect(poolBalance).to.be.equal(0)    

  })
})
