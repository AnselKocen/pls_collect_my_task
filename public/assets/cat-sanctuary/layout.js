(function (global) {
  'use strict';

  // All geometry is in source-image pixels. x/y are the cat's foot baseline.
  // The foreground layers reuse this exact image at this exact transform.
  global.CatRoomLayout = {
    image: 'assets/cat-sanctuary/room-v3-pixel.png',
    width: 1254,
    height: 1254,
    defaultNode: 'striped-bed',
    retiredNumbers: [10, 12],
    // Keep these explicit numbers stable when adding or rearranging places.
    nodes: [
      { id: 'scratch', number: 1, label: '抓板上歇歇', x: 468, y: 865, scale: .94, state: 'belly', masks: ['scratch-front'], walkable: false, behavior: { type: 'cycle', phases: [{ state: 'stretch', seconds: 6 }, { state: 'belly', seconds: 24 }] } },
      { id: 'nest', number: 2, label: '猫耳窝里趴着', x: 180, y: 790, scale: .9, state: 'idle', facing: 'right', masks: ['dome-front'], walkable: false, behavior: { type: 'cycle', phases: [{ state: 'idle', seconds: 30 }, { state: 'belly', seconds: 10 }] } },
      { id: 'yarn', number: 3, label: '爪垫上玩毛线', x: 620, y: 1080, scale: 1, state: 'yarn', masks: [], walkable: true },
      { id: 'track', number: 4, label: '玩具后面趴着', x: 625, y: 940, scale: 1, state: 'idle', masks: ['pink-yarn-front', 'ball-track-front'], walkable: true },
      { id: 'cushion', number: 5, label: '软垫上趴着', x: 576, y: 804, scale: .98, state: 'idle', masks: [], walkable: true },
      { id: 'striped-bed', number: 6, label: '条纹窝里打盹', x: 472, y: 666, scale: .92, state: 'belly', masks: ['striped-bed-front'], walkable: false },
      { id: 'tree-cubby', number: 7, label: '蘑菇树洞里待机', x: 734, y: 739, scale: .68, state: 'idle', masks: ['tree-cubby-front'], walkable: false },
      { id: 'high-perch', number: 8, label: '高处软垫上趴着', x: 742, y: 330, scale: .86, state: 'idle', masks: [], walkable: false },
      { id: 'basket-behind', number: 9, label: '玩具篮后面躲躲', x: 969, y: 936, scale: .96, state: 'idle', masks: ['toy-basket'], walkable: true },
      { id: 'upper-house', number: 11, label: '高处小屋里待着', x: 382, y: 414, scale: .94, state: 'belly', facing: 'right', masks: ['upper-house-front'], walkable: false, behavior: { type: 'cycle', phases: [{ state: 'belly', seconds: 24 }, { state: 'idle', seconds: 16 }] } },
      { id: 'wood-barrel', number: 13, label: '木桶管道里歇歇', x: 552, y: 638, scale: 1, state: 'belly', facing: 'left', masks: ['wood-barrel-shell'], walkable: false, behavior: { type: 'cycle', phases: [{ state: 'belly', seconds: 24 }, { state: 'idle', seconds: 16 }] } },
      { id: 'net-hammock', number: 14, label: '网兜里趴一会儿', x: 475, y: 537, scale: 1, state: 'belly', facing: 'left', masks: ['net-hammock-front', 'net-gold-ball', 'net-pink-ball'], walkable: false, behavior: { type: 'cycle', phases: [{ state: 'belly', seconds: 24 }, { state: 'idle', seconds: 16 }] } }
    ],
    masks: [
      {
        id: 'toy-basket',
        // Follow the strong-pixel silhouette with orthogonal steps. The cat
        // peeks above the right rim instead of through the handle aperture.
        polygon: [[835,910],[850,910],[850,915],[860,915],[860,900],[865,900],[865,895],[875,895],[875,890],[890,890],[890,895],[900,895],[900,905],[905,905],[905,925],[910,925],[910,920],[915,920],[915,915],[920,915],[920,910],[925,910],[925,905],[935,905],[935,910],[940,910],[940,915],[945,915],[945,920],[955,920],[955,925],[970,925],[970,920],[980,920],[980,925],[985,925],[985,930],[995,930],[995,945],[990,945],[990,975],[985,975],[985,985],[980,985],[980,995],[970,995],[970,1005],[955,1005],[955,1010],[935,1010],[935,1015],[915,1015],[915,1010],[890,1010],[890,1005],[875,1005],[875,1000],[865,1000],[865,995],[860,995],[860,985],[855,985],[855,975],[850,975],[850,945],[845,945],[845,935],[835,935],[835,930],[830,930],[830,915],[835,915]]
      },
      {
        id: 'dome-front',
        // Preserve the dark entrance as a hole; only the surrounding plush and
        // the front cushion lip cover the cat, not the entire dome rectangle.
        fillRule: 'evenodd',
        path: 'M125 790 L125 756 L132 734 L138 716 L141 701 L148 685 L158 679 L171 686 L183 699 L204 699 L211 683 L222 672 L234 675 L243 690 L247 708 L256 721 L264 742 L271 764 L272 791 L264 806 L246 817 L218 824 L178 825 L149 818 L132 807 Z M166 786 L166 766 L171 766 L171 752 L176 752 L176 742 L181 742 L181 735 L187 735 L187 729 L195 729 L195 725 L212 725 L212 729 L219 729 L219 735 L226 735 L226 744 L231 744 L231 754 L236 754 L236 767 L241 767 L241 787 L233 787 L233 792 L220 792 L220 795 L182 795 L182 791 L173 791 L173 786 Z'
      },
      {
        id: 'striped-bed-front',
        // The front half of the bolster only: ears/head stay above the rim.
        polygon: [[405,648],[410,640],[419,637],[421,645],[416,653],[425,659],[442,661],[486,661],[507,657],[516,651],[514,642],[520,641],[531,646],[536,655],[535,674],[525,685],[511,691],[425,691],[411,683],[405,674]]
      },
      {
        id: 'tree-cubby-front',
        // Wood face and lower green lip, with the round opening cut out.
        fillRule: 'evenodd',
        path: 'M677 683 L780 683 L780 731 L789 739 L788 747 L774 755 L688 757 L674 748 L674 739 L681 734 Z M714 704 L714 700 L720 700 L720 696 L735 696 L735 700 L742 700 L742 704 L746 704 L746 708 L750 708 L750 724 L746 724 L746 732 L742 732 L742 736 L734 736 L734 740 L716 740 L716 736 L710 736 L710 732 L706 732 L706 724 L702 724 L702 712 L706 712 L706 708 L710 708 L710 704 Z'
      },
      {
        id: 'scratch-front',
        // Only the board's lower front fascia, never its whole sloped top.
        polygon: [[365,896],[380,902],[395,907],[407,897],[421,887],[436,886],[450,887],[465,879],[480,868],[491,860],[507,861],[523,868],[539,866],[548,874],[547,888],[534,888],[520,880],[505,876],[496,883],[482,897],[465,905],[446,910],[427,907],[413,919],[400,927],[384,923],[366,914]]
      },
      {
        id: 'upper-house-front',
        // For this interior-only stop the source façade/rail region is solid,
        // with the cat-head doorway cut out. Larger actions stay inside it.
        fillRule: 'evenodd',
        path: 'M330 290 H540 V452 H330 Z M372 397 V374 H376 V363 H380 V351 H376 V343 H380 V339 H389 V343 H395 V349 H404 V346 H421 V342 H427 V337 H435 V341 H441 V359 H437 V365 H443 V374 H446 V395 H441 V402 H380 V397 Z'
      },
      {
        id: 'pink-yarn-front',
        // Only the source ball silhouette; a slight overlap covers the paws.
        polygon: [[560,932],[560,927],[579,927],[579,932],[586,932],[586,937],[591,937],[591,944],[596,944],[596,964],[591,964],[591,975],[585,975],[585,982],[574,982],[574,986],[562,986],[562,981],[554,981],[554,973],[549,973],[549,964],[546,964],[546,945],[551,945],[551,937],[556,937],[556,932]]
      },
      {
        id: 'ball-track-front',
        polygon: [[706,900],[715,900],[715,895],[771,895],[771,900],[779,900],[779,916],[789,916],[789,921],[795,921],[795,929],[804,929],[804,941],[809,941],[809,958],[804,958],[804,970],[795,970],[795,978],[781,978],[781,984],[715,984],[715,979],[702,979],[702,972],[694,972],[694,965],[689,965],[689,951],[686,951],[686,938],[693,938],[693,928],[701,928],[701,919],[706,919]]
      },
      {
        id: 'wood-barrel-shell',
        // The barrel shell and near lower lip hide the body on the right,
        // leaving the left-facing head and ears outside the opening.
        polygon: [[548,547],[574,544],[606,548],[625,559],[635,576],[641,601],[640,618],[629,633],[608,640],[557,645],[535,646],[519,642],[500,634],[493,624],[493,616],[501,624],[511,631],[527,635],[539,628],[549,612],[551,594],[547,577],[538,563],[528,557]]
      },
      {
        id: 'net-hammock-front',
        polygon: [[404,503],[414,512],[432,522],[454,529],[479,531],[502,525],[522,512],[538,491],[536,515],[521,536],[504,550],[483,559],[453,558],[431,550],[415,538],[405,522]]
      },
      {
        id: 'net-gold-ball',
        path: 'M487 454 H499 V458 H504 V474 H500 V479 H486 V475 H481 V460 H487 Z M490 425 H495 V455 H490 Z'
      },
      {
        id: 'net-pink-ball',
        path: 'M462 474 H472 V477 H477 V482 H481 V490 H477 V495 H472 V498 H462 V495 H456 V491 H452 V482 H456 V477 H462 Z M465 435 H470 V477 H465 Z'
      }
    ],
    // Ground-only paths. Raised furniture and unconnected pairs use an instant
    // position change, matching the available animation set (no jumping).
    routes: [
      {
        from: 'yarn', to: 'track',
        points: [[620,1080],[636,1036],[648,1003],[625,940]], masks: []
      },
      {
        from: 'track', to: 'cushion',
        points: [[625,940],[629,914],[602,857],[576,804]], masks: []
      },
      {
        from: 'track', to: 'basket-behind',
        points: [[625,940],[651,906],[697,873],[806,882],[829,912],[969,936]], masks: ['toy-basket']
      },
      {
        from: 'basket-behind', to: 'yarn',
        points: [[969,936],[1030,938],[1045,989],[960,1055],[799,1120],[658,1152],[620,1080]], masks: ['toy-basket']
      }
    ]
  };
})(window);
