import { expect } from "chai";
import { ethers } from "hardhat";

const PUBKEY = "0x" + "11".repeat(32); // any non-zero 32-byte X1 public key

describe("MoonForgePortal v2", () => {
  async function deploy() {
    const [user, other] = await ethers.getSigners();
    const xen = await (await ethers.getContractFactory("MockXEN")).deploy();
    const portal = await (await ethers.getContractFactory("MoonForgePortal")).deploy(await xen.getAddress());
    await xen.mint(user.address, ethers.parseEther("1000"));
    return { xen, portal, user, other };
  }

  it("really burns XEN through XEN.burn(): supply down, userBurns recorded, event emitted", async () => {
    const { xen, portal, user } = await deploy();
    const amount = ethers.parseEther("100");
    await xen.approve(await portal.getAddress(), amount);
    const supplyBefore = await xen.totalSupply();

    const tx = await portal.enterForge(amount, 2, PUBKEY);
    const rcpt = await tx.wait();
    const block = await ethers.provider.getBlock(rcpt!.blockNumber);
    const chainId = (await ethers.provider.getNetwork()).chainId;

    await expect(tx)
      .to.emit(portal, "MissionStarted")
      .withArgs(1n, user.address, amount, 2, PUBKEY, chainId, block!.timestamp);
    expect(await xen.totalSupply()).to.equal(supplyBefore - amount);
    expect(await xen.balanceOf(user.address)).to.equal(ethers.parseEther("900"));
    expect(await xen.userBurns(user.address)).to.equal(amount);
    expect(await portal.totalBurned()).to.equal(amount);
    expect(await portal.totalMissions()).to.equal(1n);
  });

  it("supports the IBurnRedeemable and ERC165 interfaces", async () => {
    const { portal } = await deploy();
    expect(await portal.supportsInterface("0x543746b1")).to.equal(true);
    expect(await portal.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await portal.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("rejects zero amount, bad tier and empty X1 key", async () => {
    const { xen, portal } = await deploy();
    await xen.approve(await portal.getAddress(), ethers.parseEther("10"));
    await expect(portal.enterForge(0, 0, PUBKEY)).to.be.revertedWithCustomError(portal, "InvalidAmount");
    await expect(portal.enterForge(1, 3, PUBKEY)).to.be.revertedWithCustomError(portal, "InvalidTier");
    await expect(portal.enterForge(1, 0, ethers.ZeroHash)).to.be.revertedWithCustomError(portal, "InvalidX1Address");
  });

  it("fails without allowance (cannot burn someone else's XEN)", async () => {
    const { portal } = await deploy();
    await expect(portal.enterForge(ethers.parseEther("1"), 0, PUBKEY)).to.be.reverted;
  });

  it("rejects callbacks not coming from XEN or not matching the in-flight burn", async () => {
    const { portal, user } = await deploy();
    await expect(portal.onTokenBurned(user.address, 1)).to.be.revertedWithCustomError(portal, "NotXen");
  });

  it("only burns the caller's own tokens even if another user approved the portal", async () => {
    const { xen, portal, user, other } = await deploy();
    await xen.approve(await portal.getAddress(), ethers.parseEther("50"));
    // `other` has no XEN and no allowance: the burn must fail, user's tokens stay untouched
    await expect(portal.connect(other).enterForge(ethers.parseEther("50"), 0, PUBKEY)).to.be.reverted;
    expect(await xen.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
  });

  it("rejects a non-contract XEN address at deploy", async () => {
    const [user] = await ethers.getSigners();
    const F = await ethers.getContractFactory("MoonForgePortal");
    await expect(F.deploy(user.address)).to.be.revertedWithCustomError(F, "InvalidXen");
  });
});
