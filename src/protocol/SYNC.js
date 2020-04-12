const {EDS} = require('../EDS');

/** CANopen SYNC protocol handler.
 *
 * The synchronization (SYNC) protocol follows a producer-consumer structure
 * that provides a basic network synchronization mechanism. There should be
 * at most one sync producer on the network at a time.
 *
 * @param {Device} device - parent device.
 * @see CiA301 "Synchronization object (SYNC)" (§7.2.5)
 * @memberof Device
 */
class SYNC {
    constructor(device) {
        this._device = device;
        this._generate = false;
        this._cobId = null;
        this._cyclePeriod = 0;
        this._overflow = 0;
        this._syncCounter = 0;
        this._syncTimer = null;
    }

    /** Set the sync generation enable bit.
     * @param {boolean} gen - enable flag.
     */
    set generate(gen) {
        let obj1005 = this._device.EDS.getEntry(0x1005);
        if(obj1005 === undefined) {
            obj1005 = this._device.EDS.addEntry(0x1005, {
                ParameterName:      'COB-ID SYNC',
                ObjectType:         EDS.objectTypes.VAR,
                DataType:           EDS.dataTypes.UNSIGNED32,
                AccessType:         EDS.accessTypes.READ_WRITE,
            });
        }

        if(gen)
            obj1005.value |= (1 << 30);
        else
            obj1005.value &= ~(1 << 30);
    }

    /** Get the sync generation enable bit.
     * @return {boolean} - enable flag.
     */
    get generate() {
        return this._generate;
    }

    /** Set the COB-ID.
     * @param {number} cobId - COB-ID.
     */
    set cobId(cobId) {
        let obj1005 = this._device.EDS.getEntry(0x1005);
        if(obj1005 === undefined) {
            obj1005 = this._device.EDS.addEntry(0x1005, {
                ParameterName:      'COB-ID SYNC',
                ObjectType:         EDS.objectTypes.VAR,
                DataType:           EDS.dataTypes.UNSIGNED32,
                AccessType:         EDS.accessTypes.READ_WRITE,
            });
        }

        cobId &= 0x7FF;
        obj1005.value = (obj1005.value & ~(0x7FF)) | cobId;
    }

    /** Get the COB-ID.
     * @return {number} - COB-ID.
     */
    get cobId() {
        return this._cobId;
    }

    /** Set the sync interval.
     * @param {number} period - cycle period (μs).
     */
    set cyclePeriod(period) {
        let obj1006 = this._device.EDS.getEntry(0x1006);
        if(obj1006 === undefined) {
            obj1006 = this._device.EDS.addEntry(0x1006, {
                ParameterName:      'Communication cycle period',
                ObjectType:         EDS.objectTypes.VAR,
                DataType:           EDS.dataTypes.UNSIGNED32,
                AccessType:         EDS.accessTypes.READ_WRITE,
            });
        }

        obj1006.value = period;
    }

    /** Get the sync interval.
     * @return {number} - cycle period (μs)
     */
    get cyclePeriod() {
        return this._cyclePeriod;
    }

    /** Set the sync counter overflow value.
     * @param {number} overflow - overflow value.
     */
    set overflow(overflow) {
        let obj1019 = this._device.EDS.getEntry(0x1019);
        if(obj1019 === undefined) {
            obj1019 = this._device.EDS.addEntry(0x1019, {
                ParameterName:      'Synchronous counter overflow value',
                ObjectType:         EDS.objectTypes.VAR,
                DataType:           EDS.dataTypes.UNSIGNED8,
                AccessType:         EDS.accessTypes.READ_WRITE,
            });
        }

        overflow &= 0xFF;
        obj1019.value = overflow;
    }

    /** Get the sync counter overflow value.
     * @return {number} - overflow value.
     */
    get overflow() {
        return this._overflow;
    }

    /** Initialize members and begin consuming sync objects. */
    init() {
        /* Object 0x1005 - COB-ID SYNC. */
        const obj1005 = this._device.EDS.getEntry(0x1005);
        if(obj1005) {
            this._parse1005(obj1005);
            obj1005.addListener('update', this._parse1005.bind(this));

            this._device.addListener('message', this._onMessage.bind(this));
        }

        /* Object 0x1006 - Communication cycle period. */
        const obj1006 = this._device.EDS.getEntry(0x1006);
        if(obj1006) {
            this._parse1006(obj1006);
            obj1006.addListener('update', this._parse1006.bind(this));
        }

        /* Object 0x1019 - Synchronous counter overflow value. */
        const obj1019 = this._device.EDS.getEntry(0x1019);
        if(obj1019) {
            this._parse1019(obj1019);
            obj1019.addListener('update', this._parse1019.bind(this));
        }
    }

    /** Begin producing sync objects. */
    start() {
        if(!this.generate)
            throw TypeError('SYNC generation is disabled.');

        if(this._overflow) {
            this._syncTimer = setInterval(() => {
                    this._syncCounter += 1;
                    if(this._syncCounter > this._overflow)
                        this._syncCounter = 1;

                    this.write(this._syncCounter);
                }, this._cyclePeriod / 1000);
        }
        else {
            this._syncTimer = setInterval(() => {
                this.write();
            }, this._cyclePeriod / 1000);
        }
    }

    /** Stop producing sync objects. */
    stop() {
        clearInterval(this._syncTimer);
        this._syncTimer = null;
        this._syncCounter = 0;
    }

    /** Service: SYNC write.
     * @param {number | null} counter - sync counter;
     */
    write(counter=null) {
        if(!this.generate)
            throw TypeError('SYNC generation is disabled.');

        const data = (counter) ? Buffer.from([counter]) : Buffer.alloc(0);
        this._device.send({
            id:     this.cobId,
            data:   data,
        });
    }

    /** Called when a new CAN message is received.
     * @private
     * @param {Object} message - CAN frame.
     */
    _onMessage(message) {
        if((message.id & 0x7FF) != this._cobId)
            return;

        if(message.data)
            this._device.emit('sync', message.data[1]);
        else
            this._device.emit('sync');
    }

    /** Called when 0x1005 (COB-ID SYNC) is updated.
     * @private
     * @param {DataObject} data - updated DataObject.
     */
    _parse1005(data) {
        /* Object 0x1005 - COB-ID SYNC.
         *   bit 0..10      11-bit CAN base frame.
         *   bit 11..28     29-bit CAN extended frame.
         *   bit 29         Frame type.
         *   bit 30         Produce sync objects.
         */
        const value = data.value;
        const gen = (value >> 30) & 0x1
        const rtr = (value >> 29) & 0x1;
        const cobId = value & 0x7FF;

        if(rtr == 0x1)
            throw TypeError("CAN extended frames are not supported.")

        if(cobId == 0)
            throw TypeError('COB-ID SYNC can not be 0.');

        this._generate = !!gen;
        this._cobId = cobId;
    }

    /** Called when 0x1006 (Communication cycle period) is updated.
     * @private
     * @param {DataObject} data - updated DataObject.
     */
    _parse1006(data) {
        const cyclePeriod = data.value;
        if(cyclePeriod == 0)
            throw TypeError('Communication cycle period can not be 0.')

        this._cyclePeriod = cyclePeriod;
    }

    /** Called when 0x1019 (Synchronous counter overflow value) is updated.
     * @private
     * @param {DataObject} data - updated DataObject.
     */
    _parse1019(data) {
        this._overflow = data.value;
    }
}

module.exports=exports=SYNC;
